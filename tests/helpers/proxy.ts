/**
 * tests/helpers/proxy.ts
 *
 * In-process Fastify proxy harness for integration tests.
 *
 * Assembles the exact same pipeline as src/server.ts without its module-level
 * side effects (dotenv auto-load, undici global dispatcher, hardcoded listen).
 *
 * Usage:
 *   const proxy = await startTestProxy();
 *   // proxy.url  → "http://127.0.0.1:PORT"
 *   // proxy.close() → graceful shutdown
 *
 *   const proxy = await startTestProxy({ POLICY_MODE: "audit" });
 */

import Fastify from "fastify";
import { parseTransaction } from "viem";
import { JevClient } from "../../src/jevClient.js";
import { PolicyEngine } from "../../src/policy.js";
import { SimulationEngine } from "../../src/simulation.js";
import type {
  CircuitBreakerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  PolicyMode,
  TransactionPayload,
  UserOperation,
} from "../../src/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestProxy {
  url:   string;
  port:  number;
  close: () => Promise<void>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function startTestProxy(
  envOverrides: Partial<Record<string, string>> = {}
): Promise<TestProxy> {
  // Merge env overrides (do not mutate process.env permanently)
  const env = {
    JEV_API_KEY:             "test-api-key-for-jest",
    JEV_ENDPOINT:            "https://api.typesafe.ai/v1/decide",
    UPSTREAM_RPC:            "http://127.0.0.1:8546",
    POLICY_MODE:             "strict",
    ANALYSIS_TIMEOUT_MS:     "800",
    MAX_CONCURRENT_ANALYSES: "50",
    ...envOverrides,
  };

  const upstreamRpc  = env["UPSTREAM_RPC"]!;
  const policyMode   = (env["POLICY_MODE"] ?? "strict") as PolicyMode;
  const jevEndpoint  = env["JEV_ENDPOINT"];
  const jevApiKey    = env["JEV_API_KEY"]!;
  const timeoutMs    = parseInt(env["ANALYSIS_TIMEOUT_MS"] ?? "800", 10);
  const maxConc      = parseInt(env["MAX_CONCURRENT_ANALYSES"] ?? "50", 10);

  const proxyConfig: CircuitBreakerConfig = {
    rpcUrl:            upstreamRpc,
    policy:            policyMode,
    jevEndpoint,
    jevApiKey,
    analysisTimeoutMs: timeoutMs,
  };

  const jevClient  = new JevClient(jevEndpoint, jevApiKey);
  const simulator  = new SimulationEngine(upstreamRpc);
  const policy     = new PolicyEngine(proxyConfig);

  // Bounded concurrency semaphore (same as server.ts)
  let slots = maxConc;
  const queue: Array<() => void> = [];
  const semAcquire = (): Promise<void> => {
    if (slots > 0) { slots--; return Promise.resolve(); }
    return new Promise(r => queue.push(r));
  };
  const semRelease = () => {
    const next = queue.shift();
    if (next) next(); else slots++;
  };

  const fastify = Fastify({ logger: false });

  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch (err) { done(err as Error); }
  });

  // ── Routes ──────────────────────────────────────────────────────────────────

  fastify.post<{ Body: JsonRpcRequest | JsonRpcRequest[] }>("/", async (request) => {
    const body  = request.body;
    const reqId = request.id as string;
    if (Array.isArray(body)) {
      return Promise.all(body.map(req => handleRequest(req, reqId)));
    }
    return handleRequest(body, reqId);
  });

  fastify.get("/health", () => ({
    status: "ok", version: "1.0.0", policy: policyMode,
    upstream: upstreamRpc, sdk: "@breaker/viem-middleware", pid: process.pid,
  }));

  fastify.get("/policy", () => ({
    mode: policy.policyMode, thresholds: policy.activeThresholds,
  }));

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleRequest(req: JsonRpcRequest, reqId: string): Promise<JsonRpcResponse> {
    try {
      if (req.method === "eth_sendRawTransaction") {
        await semAcquire();
        try { return await interceptRawTransaction(req, reqId); }
        finally { semRelease(); }
      }
      if (req.method === "eth_sendUserOperation") {
        await semAcquire();
        try { return await interceptUserOperation(req, reqId); }
        finally { semRelease(); }
      }
      return forwardUpstream(req, reqId);
    } catch (err) {
      return { jsonrpc: "2.0", id: req.id,
        error: { code: -32603, message: `Internal proxy error: ${(err as Error).message}` } };
    }
  }

  async function interceptRawTransaction(req: JsonRpcRequest, reqId: string): Promise<JsonRpcResponse> {
    const rawTx = (req.params as string[])[0];
    if (!rawTx) return errResp(req.id, -32602, "Missing raw transaction parameter");

    let parsedRaw: Record<string, unknown>;
    try {
      parsedRaw = parseTransaction(rawTx as `0x${string}`) as Record<string, unknown>;
    } catch {
      return errResp(req.id, -32602, "Failed to parse raw transaction");
    }

    const gas     = typeof parsedRaw["gas"]     === "bigint" ? (parsedRaw["gas"] as bigint).toString() : undefined;
    const nonce   = typeof parsedRaw["nonce"]   === "number" ? parsedRaw["nonce"] as number : undefined;
    const chainId = typeof parsedRaw["chainId"] === "number" ? parsedRaw["chainId"] as number : undefined;

    const tx: TransactionPayload = {
      from:  "unknown", // raw tx has no from on the type — recovered at runtime
      to:    typeof parsedRaw["to"]    === "string" ? parsedRaw["to"]    : "0x0000000000000000000000000000000000000000",
      data:  typeof parsedRaw["data"]  === "string" ? parsedRaw["data"]  : "0x",
      value: typeof parsedRaw["value"] === "bigint" ? (parsedRaw["value"] as bigint).toString() : "0",
    };
    if (gas     !== undefined) tx.gas     = gas;
    if (nonce   !== undefined) tx.nonce   = nonce;
    if (chainId !== undefined) tx.chainId = chainId;

    return runPipeline(req, tx, reqId);
  }

  async function interceptUserOperation(req: JsonRpcRequest, reqId: string): Promise<JsonRpcResponse> {
    const [userOp] = req.params as [UserOperation, string?];
    if (!userOp) return errResp(req.id, -32602, "Missing UserOperation parameter");

    const to = decodeUoTarget(userOp.callData) ?? userOp.sender;
    const tx: TransactionPayload = {
      from: userOp.sender, to, data: userOp.callData, value: "0", gas: userOp.callGasLimit,
    };
    return runPipeline(req, tx, reqId);
  }

  async function runPipeline(req: JsonRpcRequest, tx: TransactionPayload, reqId: string): Promise<JsonRpcResponse> {
    const simulation = await withTimeout(simulator.simulate(tx), timeoutMs, undefined);
    const decision   = await jevClient.evaluate(tx, simulation, timeoutMs);
    const verdict    = policy.evaluate(decision, tx);

    if (verdict.action === "block") {
      return {
        jsonrpc: "2.0", id: req.id,
        error: {
          code:    -32003,
          message: `[CircuitBreaker-AI] Transaction blocked. ${verdict.reason ?? ""}`,
          data:    { reqId, decision: {
            risk_category:       decision.risk_category,
            risk_flags:          decision.risk_flags,
            exploit_probability: decision.exploit_probability,
            severity_score:      decision.severity_score,
            rationale:           decision.rationale,
          }},
        },
      };
    }

    if (verdict.action === "warn") {
      const upstream = await forwardUpstream(req, reqId);
      if (upstream.result !== undefined) {
        (upstream as JsonRpcResponse & { warning?: unknown }).warning = {
          risk_category: decision.risk_category,
          exploit_probability: decision.exploit_probability,
        };
      }
      return upstream;
    }

    return forwardUpstream(req, reqId);
  }

  async function forwardUpstream(req: JsonRpcRequest, reqId: string): Promise<JsonRpcResponse> {
    const res = await fetch(upstreamRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": reqId },
      body: JSON.stringify(req),
    });
    return res.json() as Promise<JsonRpcResponse>;
  }

  // ── Start ────────────────────────────────────────────────────────────────────

  await fastify.listen({ port: 0, host: "127.0.0.1" });

  const addr = fastify.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 8545;

  return {
    url:   `http://127.0.0.1:${port}`,
    port,
    close: () => fastify.close(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errResp(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function decodeUoTarget(callData: string): string | undefined {
  if (!callData.startsWith("0xb61d27f6") || callData.length < 74) return undefined;
  return `0x${callData.slice(34, 74)}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([promise, race]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
