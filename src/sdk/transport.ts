/**
 * @breaker/viem-middleware — viem Custom Transport
 *
 * Wraps any viem-compatible HTTP transport and intercepts every
 * eth_sendRawTransaction / eth_sendUserOperation request through
 * the CircuitBreaker analysis pipeline before it reaches the RPC.
 *
 * All other JSON-RPC methods (reads, simulations, gas estimations) pass
 * through at zero overhead — the analysis gate is send-only.
 */

import {
  custom,
  type CustomTransport,
} from "viem";
import { JevClient } from "../jevClient.js";
import { PolicyEngine } from "../policy.js";
import { SimulationEngine } from "../simulation.js";
import type {
  CircuitBreakerConfig,
  DecisionMatrix,
  TransactionPayload,
  UserOperation,
} from "../types.js";

// ─── Unused type aliases removed (were only used for the deleted EIP1193RequestFn cast)
// RpcSchema type removed — custom() accepts request: any

// ─── Public Error Class ───────────────────────────────────────────────────────

export class CircuitBreakerBlockedError extends Error {
  public readonly decision: DecisionMatrix;
  public readonly code = -32003;

  constructor(decision: DecisionMatrix, reason: string) {
    super(`[CircuitBreaker-AI] ${reason}`);
    this.name    = "CircuitBreakerBlockedError";
    this.decision = decision;
  }
}

// ─── Intercepting Transport ───────────────────────────────────────────────────

/**
 * Creates a viem CustomTransport that runs every send-class request through
 * the CircuitBreaker analysis pipeline.  Wrap your existing RPC URL:
 *
 * ```ts
 * const client = createWalletClient({
 *   transport: createCircuitBreakerTransport(config),
 * });
 * ```
 */
export function createCircuitBreakerTransport(
  config: CircuitBreakerConfig
): CustomTransport {
  const jev       = new JevClient(config.jevEndpoint, config.jevApiKey);
  const engine    = new SimulationEngine(config.rpcUrl);
  const policy    = new PolicyEngine(config);
  const timeoutMs = config.analysisTimeoutMs ?? 800;

  // The underlying pass-through: viem's built-in http transport sends to rpcUrl
  const upstream = buildUpstreamFetch(config.rpcUrl);

  // Use a loose function type to avoid EIP1193RequestFn generic variance issues
  const requestFn = async ({ method, params }: { method: string; params?: unknown }) => {
    // ── Fast path: non-send methods pass through immediately ──────────────
    if (method !== "eth_sendRawTransaction" && method !== "eth_sendUserOperation") {
      return upstream(method, (params as unknown[]) ?? []);
    }

    // ── Build TransactionPayload from raw params ───────────────────────────
    let tx: TransactionPayload;

    if (method === "eth_sendRawTransaction") {
      const rawTx = (params as string[])[0];
      if (!rawTx) throw new Error("eth_sendRawTransaction: missing raw tx");
      tx = await decodeRawTransaction(rawTx);
    } else {
      // eth_sendUserOperation
      const [userOp] = params as [UserOperation, string?];
      if (!userOp) throw new Error("eth_sendUserOperation: missing UserOperation");
      tx = decodeUserOperation(userOp);
    }

    // ── Simulate ──────────────────────────────────────────────────────────
    const simulation = await withTimeout(
      engine.simulate(tx),
      timeoutMs,
      undefined
    );

    // ── AI Decision ───────────────────────────────────────────────────────
    const decision = await jev.evaluate(tx, simulation, timeoutMs);
    const verdict  = policy.evaluate(decision, tx);

    // ── Gate ──────────────────────────────────────────────────────────────
    if (verdict.action === "block") {
      throw new CircuitBreakerBlockedError(
        decision,
        verdict.reason ?? `Exploit probability ${(decision.exploit_probability * 100).toFixed(1)}%`
      );
    }

    // Forward: allow + warn both reach the RPC
    return upstream(method, (params as unknown[]) ?? []);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return custom({ request: requestFn as any });
}

// ─── Decoding Helpers ─────────────────────────────────────────────────────────

async function decodeRawTransaction(rawTx: string): Promise<TransactionPayload> {
  const { parseTransaction } = await import("viem");
  // viem's type for parseTransaction doesn't expose `from` but it's present at runtime
  const parsed = parseTransaction(rawTx as `0x${string}`) as Record<string, unknown>;
  const gas    = typeof parsed["gas"] === "bigint" ? (parsed["gas"] as bigint).toString() : undefined;
  const nonce  = typeof parsed["nonce"] === "number" ? parsed["nonce"] as number : undefined;
  const chainId = typeof parsed["chainId"] === "number" ? parsed["chainId"] as number : undefined;
  const result: TransactionPayload = {
    from:  typeof parsed["from"] === "string" ? parsed["from"] : "unknown",
    to:    typeof parsed["to"]   === "string" ? parsed["to"]   : "0x0000000000000000000000000000000000000000",
    data:  typeof parsed["data"] === "string" ? parsed["data"] : "0x",
    value: typeof parsed["value"] === "bigint" ? (parsed["value"] as bigint).toString() : "0",
  };
  if (gas     !== undefined) result.gas     = gas;
  if (nonce   !== undefined) result.nonce   = nonce;
  if (chainId !== undefined) result.chainId = chainId;
  return result;
}

function decodeUserOperation(userOp: UserOperation): TransactionPayload {
  const to = decodeUserOpTarget(userOp.callData) ?? userOp.sender;
  return {
    from:  userOp.sender,
    to,
    data:  userOp.callData,
    value: "0",
    gas:   userOp.callGasLimit,
  };
}

function decodeUserOpTarget(callData: string): string | undefined {
  if (!callData.startsWith("0xb61d27f6") || callData.length < 74) return undefined;
  return `0x${callData.slice(34, 74)}`;
}

// ─── Upstream Fetch ───────────────────────────────────────────────────────────

function buildUpstreamFetch(rpcUrl: string) {
  return async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json() as { result?: unknown; error?: { code: number; message: string } };
    if (json.error) {
      throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  };
}

// ─── Timeout Utility ──────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, race]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
