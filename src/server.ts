/**
 * CircuitBreaker-AI — JSON-RPC Proxy Server
 *
 * Production-hardened entry point with:
 *   - dotenv loaded before any other import reads process.env
 *   - Startup config validation (fails fast on missing secrets)
 *   - HTTP keep-alive / connection pooling for upstream RPC and JEV
 *   - Bounded concurrency (semaphore) to prevent analysis queue blow-up
 *   - Request-ID correlation header propagated through the full pipeline
 *   - Graceful shutdown on SIGTERM / SIGINT
 *
 * Pipeline per send-class request:
 *   1. Parse incoming JSON-RPC request
 *   2. Simulate (debug_traceCall / eth_call)
 *   3. Evaluate with JEV AI → DecisionMatrix
 *   4. Apply PolicyEngine → PolicyVerdict
 *   5. Block (return error -32003) or forward upstream
 */

// ── dotenv MUST be first — before any other module reads process.env ─────────
import "dotenv/config";

import Fastify from "fastify";
import { parseTransaction } from "viem";
import { JevClient } from "./jevClient.js";
import { PolicyEngine } from "./policy.js";
import { SimulationEngine } from "./simulation.js";
import type {
  CircuitBreakerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  PolicyMode,
  TransactionPayload,
  UserOperation,
} from "./types.js";

// ─── Startup Config Validation ────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[CircuitBreaker-AI] FATAL: Missing required environment variable "${name}".`);
    console.error(`  → Copy .env.example to .env and fill in your values.`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Fail fast — no silent no-ops with a dummy key
const JEV_API_KEY   = requireEnv("JEV_API_KEY");
const UPSTREAM_RPC  = optionalEnv("UPSTREAM_RPC",  "https://eth.llamarpc.com");
const LISTEN_PORT   = parseInt(optionalEnv("PORT",  "8545"), 10);
const POLICY_MODE   = optionalEnv("POLICY_MODE",   "strict") as PolicyMode;
const JEV_ENDPOINT  = optionalEnv("JEV_ENDPOINT",  "https://api.typesafe.ai/v1/decide");
const ANALYSIS_TIMEOUT_MS    = parseInt(optionalEnv("ANALYSIS_TIMEOUT_MS",    "800"),  10);
const MAX_CONCURRENT_ANALYSES = parseInt(optionalEnv("MAX_CONCURRENT_ANALYSES", "50"), 10);

// ─── HTTP Keep-Alive Agent ────────────────────────────────────────────────────
// Install a shared undici Agent as the global dispatcher so every outbound
// fetch() call reuses persistent TCP connections instead of opening new ones.
// undici is bundled with Node 18+ but also available as a standalone package.

import undici from "undici";

undici.setGlobalDispatcher(
  new undici.Agent({
    keepAliveTimeout:    30_000,
    keepAliveMaxTimeout: 600_000,
    connections:         50,
    pipelining:          1,
  })
);

// ─── Concurrency Semaphore ────────────────────────────────────────────────────
// Prevents analysis goroutine explosion under mempool spike loads.

class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.slots = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.slots++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT_ANALYSES);

// ─── Bootstrap Components ─────────────────────────────────────────────────────

const proxyConfig: CircuitBreakerConfig = {
  rpcUrl:            UPSTREAM_RPC,
  policy:            POLICY_MODE,
  jevEndpoint:       JEV_ENDPOINT,
  jevApiKey:         JEV_API_KEY,
  analysisTimeoutMs: ANALYSIS_TIMEOUT_MS,
  onDecision: (decision, tx) => {
    fastify.log.info({
      event:               "decision",
      to:                  tx.to,
      risk_category:       decision.risk_category,
      exploit_probability: decision.exploit_probability,
      severity_score:      decision.severity_score,
    });
  },
  onBlock: (decision, tx) => {
    fastify.log.warn({
      event:         "blocked",
      to:            tx.to,
      risk_category: decision.risk_category,
      rationale:     decision.rationale,
    });
  },
};

const jevClient  = new JevClient(proxyConfig.jevEndpoint, proxyConfig.jevApiKey);
const simulator  = new SimulationEngine(UPSTREAM_RPC);
const policy     = new PolicyEngine(proxyConfig);

// ─── Server ───────────────────────────────────────────────────────────────────

const isProd = process.env["NODE_ENV"] === "production";
const fastify = Fastify({
  logger: isProd
    ? { level: "info" }
    : { level: "debug", transport: { target: "pino-pretty", options: { colorize: true } } },
  genReqId: () => crypto.randomUUID(),
  requestIdHeader: "x-request-id",
  requestIdLogLabel: "reqId",
});

fastify.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  }
);

// ─── Routes ───────────────────────────────────────────────────────────────────

fastify.post<{ Body: JsonRpcRequest | JsonRpcRequest[] }>(
  "/",
  async (request, reply) => {
    const body  = request.body;
    const reqId = request.id as string;

    if (Array.isArray(body)) {
      const results = await Promise.all(
        body.map(req => handleRequest(req, reqId))
      );
      return reply.send(results);
    }

    return reply.send(await handleRequest(body, reqId));
  }
);

fastify.get("/health", async (_req, reply) =>
  reply.send({
    status:   "ok",
    version:  "1.0.0",
    policy:   POLICY_MODE,
    upstream: UPSTREAM_RPC,
    sdk:      "@breaker/viem-middleware",
    pid:      process.pid,
  })
);

fastify.get("/policy", async (_req, reply) =>
  reply.send({
    mode:       policy.policyMode,
    thresholds: policy.activeThresholds,
  })
);

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest, reqId: string): Promise<JsonRpcResponse> {
  try {
    if (req.method === "eth_sendRawTransaction") {
      return await semaphore.run(() => interceptRawTransaction(req, reqId));
    }
    if (req.method === "eth_sendUserOperation") {
      return await semaphore.run(() => interceptUserOperation(req, reqId));
    }
    return await forwardUpstream(req, reqId);
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id:      req.id,
      error:   { code: -32603, message: `Internal proxy error: ${(err as Error).message}` },
    };
  }
}

// ─── eth_sendRawTransaction ───────────────────────────────────────────────────

async function interceptRawTransaction(
  req: JsonRpcRequest,
  reqId: string
): Promise<JsonRpcResponse> {
  const rawTx = (req.params as string[])[0];
  if (!rawTx) return errorResponse(req.id, -32602, "Missing raw transaction parameter");

  let parsedRaw: Record<string, unknown>;
  try {
    parsedRaw = parseTransaction(rawTx as `0x${string}`) as Record<string, unknown>;
  } catch {
    return errorResponse(req.id, -32602, "Failed to parse raw transaction");
  }

  const gas     = typeof parsedRaw["gas"]     === "bigint" ? (parsedRaw["gas"] as bigint).toString() : undefined;
  const nonce   = typeof parsedRaw["nonce"]   === "number" ? parsedRaw["nonce"] as number : undefined;
  const chainId = typeof parsedRaw["chainId"] === "number" ? parsedRaw["chainId"] as number : undefined;

  const tx: TransactionPayload = {
    from:  typeof parsedRaw["from"]  === "string" ? parsedRaw["from"]  : "unknown",
    to:    typeof parsedRaw["to"]    === "string" ? parsedRaw["to"]    : "0x0000000000000000000000000000000000000000",
    data:  typeof parsedRaw["data"]  === "string" ? parsedRaw["data"]  : "0x",
    value: typeof parsedRaw["value"] === "bigint" ? (parsedRaw["value"] as bigint).toString() : "0",
  };
  if (gas     !== undefined) tx.gas     = gas;
  if (nonce   !== undefined) tx.nonce   = nonce;
  if (chainId !== undefined) tx.chainId = chainId;

  return runAnalysisPipeline(req, tx, reqId);
}

// ─── eth_sendUserOperation (ERC-4337) ────────────────────────────────────────

async function interceptUserOperation(
  req: JsonRpcRequest,
  reqId: string
): Promise<JsonRpcResponse> {
  const [userOp] = req.params as [UserOperation, string?];
  if (!userOp) return errorResponse(req.id, -32602, "Missing UserOperation parameter");

  const tx: TransactionPayload = {
    from:  userOp.sender,
    to:    decodeUserOpTarget(userOp.callData) ?? userOp.sender,
    data:  userOp.callData,
    value: "0",
    gas:   userOp.callGasLimit,
  };

  return runAnalysisPipeline(req, tx, reqId);
}

// ─── Shared Analysis Pipeline ─────────────────────────────────────────────────

async function runAnalysisPipeline(
  req:   JsonRpcRequest,
  tx:    TransactionPayload,
  reqId: string
): Promise<JsonRpcResponse> {
  const simulation = await withTimeout(
    simulator.simulate(tx),
    ANALYSIS_TIMEOUT_MS,
    undefined
  );

  const decision = await jevClient.evaluate(tx, simulation, ANALYSIS_TIMEOUT_MS);
  const verdict  = policy.evaluate(decision, tx);

  if (verdict.action === "block") {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code:    -32003,
        message: `[CircuitBreaker-AI] Transaction blocked. ${verdict.reason ?? ""}`,
        data: {
          reqId,
          decision: {
            risk_category:       decision.risk_category,
            risk_flags:          decision.risk_flags,
            exploit_probability: decision.exploit_probability,
            severity_score:      decision.severity_score,
            rationale:           decision.rationale,
          },
        },
      },
    };
  }

  if (verdict.action === "warn") {
    const upstream = await forwardUpstream(req, reqId);
    if (upstream.result !== undefined) {
      (upstream as JsonRpcResponse & { warning?: unknown }).warning = {
        risk_category:       decision.risk_category,
        exploit_probability: decision.exploit_probability,
        severity_score:      decision.severity_score,
        rationale:           decision.rationale,
      };
    }
    return upstream;
  }

  return forwardUpstream(req, reqId);
}

// ─── Upstream Forwarding ──────────────────────────────────────────────────────

async function forwardUpstream(req: JsonRpcRequest, reqId: string): Promise<JsonRpcResponse> {
  const res = await fetch(UPSTREAM_RPC, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": reqId,
    },
    body: JSON.stringify(req),
  });
  return res.json() as Promise<JsonRpcResponse>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResponse(
  id:      number | string | null,
  code:    number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function decodeUserOpTarget(callData: string): string | undefined {
  if (!callData.startsWith("0xb61d27f6") || callData.length < 74) return undefined;
  return `0x${callData.slice(34, 74)}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([promise, race]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  fastify.log.info({ event: "shutdown", signal }, "Shutting down gracefully…");
  try {
    await fastify.close();
    fastify.log.info("Server closed. Bye.");
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

// ─── Start ────────────────────────────────────────────────────────────────────

fastify.listen({ port: LISTEN_PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info({
    event:       "started",
    port:        LISTEN_PORT,
    policy:      POLICY_MODE,
    upstream:    UPSTREAM_RPC,
    timeout_ms:  ANALYSIS_TIMEOUT_MS,
    concurrency: MAX_CONCURRENT_ANALYSES,
    pid:         process.pid,
  }, "⚡ CircuitBreaker-AI proxy listening");
});
