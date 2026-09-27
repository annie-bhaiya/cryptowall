/**
 * Simulation Engine
 *
 * Runs a stateless eth_call simulation against the upstream RPC using the
 * debug_traceCall method (Geth/Erigon compatible) before a transaction is
 * broadcast.  Falls back to a lightweight eth_call when trace is unavailable.
 *
 * Output: typed SimulationTrace used by both the JEV client and policy engine.
 */

import type {
  CallFrame,
  SimulationTrace,
  StateChange,
  TransactionPayload,
} from "./types.js";

// ─── ERC-20 Function Selectors ────────────────────────────────────────────────

const SELECTOR = {
  transfer:     "0xa9059cbb",
  transferFrom: "0x23b872dd",
  approve:      "0x095ea7b3",
  mint:         "0x40c10f19",
} as const;

// MAX_UINT256 approval (unlimited)
const MAX_UINT256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ─── Simulation Engine ────────────────────────────────────────────────────────

export class SimulationEngine {
  private readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  /**
   * Simulate a transaction.  Tries debug_traceCall first; falls back to
   * eth_call for RPC providers that don't support tracing.
   */
  async simulate(
    tx: TransactionPayload,
    blockTag: string = "latest"
  ): Promise<SimulationTrace> {
    try {
      return await this.traceCall(tx, blockTag);
    } catch {
      // Provider doesn't support debug_traceCall — use eth_call fallback
      return await this.ethCallFallback(tx, blockTag);
    }
  }

  // ── debug_traceCall (Geth / Erigon / Hardhat / Tenderly) ─────────────────

  private async traceCall(
    tx: TransactionPayload,
    blockTag: string
  ): Promise<SimulationTrace> {
    const res = await this.rpc("debug_traceCall", [
      {
        from:                 tx.from,
        to:                   tx.to,
        data:                 tx.data,
        value:                tx.value === "0" ? "0x0" : `0x${BigInt(tx.value).toString(16)}`,
        gas:                  tx.gas,
        maxFeePerGas:         tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      },
      blockTag,
      { tracer: "callTracer", tracerConfig: { withLog: true } },
    ]);

    if (res.error) {
      throw new Error(`debug_traceCall error: ${JSON.stringify(res.error)}`);
    }

    const trace = res.result as GethCallTrace;
    const callFrames = flattenCallTrace(trace, 0);
    const stateChanges = extractStateChanges(callFrames, tx.data);
    const slippageBps = estimateSlippage(stateChanges);

    return {
      reverted:      trace.error !== undefined,
      revert_reason: trace.error,
      gas_used:      BigInt(trace.gasUsed ?? "0x0"),
      state_changes: stateChanges,
      call_trace:    callFrames,
      slippage_bps:  slippageBps,
    };
  }

  // ── eth_call fallback ─────────────────────────────────────────────────────

  private async ethCallFallback(
    tx: TransactionPayload,
    blockTag: string
  ): Promise<SimulationTrace> {
    const res = await this.rpc("eth_call", [
      {
        from:  tx.from,
        to:    tx.to,
        data:  tx.data,
        value: tx.value === "0" ? "0x0" : `0x${BigInt(tx.value).toString(16)}`,
        gas:   tx.gas,
      },
      blockTag,
    ]);

    const reverted = !!res.error;
    const revertReason = decodeRevertReason(res.error?.data);
    const stateChanges = extractStateChangesFromCalldata(tx.data);

    return {
      reverted,
      revert_reason: revertReason,
      gas_used:      0n,
      state_changes: stateChanges,
      call_trace:    [],
      slippage_bps:  undefined,
    };
  }

  // ── RPC helper ────────────────────────────────────────────────────────────

  private async rpc(
    method: string,
    params: unknown[]
  ): Promise<{ result?: unknown; error?: { code: number; message: string; data?: string } }> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return res.json() as Promise<{ result?: unknown; error?: { code: number; message: string; data?: string } }>;
  }
}

// ─── Geth Trace Wire Type ─────────────────────────────────────────────────────

interface GethCallTrace {
  type:    string;
  from:    string;
  to?:     string;
  value?:  string;
  gas?:    string;
  gasUsed?: string;
  input:   string;
  output?: string;
  error?:  string;
  calls?:  GethCallTrace[];
}

// ─── Trace Flattening ─────────────────────────────────────────────────────────

function flattenCallTrace(trace: GethCallTrace, depth: number): CallFrame[] {
  const frame: CallFrame = {
    from:      trace.from ?? "0x0000000000000000000000000000000000000000",
    to:        trace.to ?? "0x",
    value:     BigInt(trace.value ?? "0x0"),
    input:     trace.input ?? "0x",
    output:    trace.output,
    gas_used:  BigInt(trace.gasUsed ?? "0x0"),
    depth,
    reverted:  trace.error !== undefined,
  };

  const frames: CallFrame[] = [frame];

  if (trace.calls) {
    for (const child of trace.calls) {
      frames.push(...flattenCallTrace(child, depth + 1));
    }
  }

  return frames;
}

// ─── State Change Extraction ──────────────────────────────────────────────────

/**
 * Extract ERC-20 / ETH state changes from call frames.
 * Works on full traces from debug_traceCall.
 */
function extractStateChanges(frames: CallFrame[], _rootData: string): StateChange[] {
  const changes: StateChange[] = [];

  for (const frame of frames) {
    const input = frame.input ?? "";
    const sel = input.slice(0, 10).toLowerCase();
    if (sel === "0xb61d27f6" && input.length >= 266 && frames.length === 1) {
      const inner = extractStateChangesFromCalldata(input);
      changes.push(...inner);
      continue;
    }
    const token = frame.to.toLowerCase();

    if (sel === SELECTOR.transfer) {
      const to    = `0x${frame.input.slice(34, 74)}`;
      const amount = BigInt(`0x${frame.input.slice(74, 138)}`);
      changes.push({ type: "erc20_transfer", token, from: frame.from, to, amount });
    } else if (sel === SELECTOR.transferFrom) {
      const from   = `0x${frame.input.slice(34, 74)}`;
      const to     = `0x${frame.input.slice(98, 138)}`;
      const amount = BigInt(`0x${frame.input.slice(138, 202)}`);
      changes.push({ type: "erc20_transfer", token, from, to, amount });
    } else if (sel === SELECTOR.approve) {
      const spender = `0x${frame.input.slice(34, 74)}`;
      const amount  = BigInt(`0x${frame.input.slice(74, 138)}`);
      changes.push({ type: "erc20_approval", token, from: frame.from, spender, amount });
    } else if (frame.value > 0n) {
      changes.push({
        type:   "eth_transfer",
        from:   frame.from,
        to:     frame.to,
        amount: frame.value,
      });
    }
  }

  return changes;
}

/**
 * Lightweight fallback: extract state changes directly from top-level calldata
 * when we only have eth_call (no trace).
 * Exported for direct unit testing.
 */
export function extractStateChangesFromCalldata(data: string): StateChange[] {
  const changes: StateChange[] = [];
  const sel = data.slice(0, 10).toLowerCase();

  // If this is an ERC-4337 execute(address,uint256,bytes) call, decode inner call
  if (sel === "0xb61d27f6" && data.length >= 266) {
    const innerData = "0x" + data.slice(266);
    return extractStateChangesFromCalldata(innerData);
  }

  if (sel === SELECTOR.approve && data.length >= 138) {
    const spender = `0x${data.slice(34, 74)}`;
    const amountHex = data.slice(74, 138);
    const amount = BigInt(`0x${amountHex}`);
    const isUnlimited = amountHex === MAX_UINT256;

    changes.push({
      type:    "erc20_approval",
      from:    "unknown",
      spender,
      amount,
      // Mark unlimited approvals with a sentinel so policy engine can flag them
      token:   isUnlimited ? "unlimited" : undefined,
    });
  } else if (sel === SELECTOR.transfer && data.length >= 138) {
    const to     = `0x${data.slice(34, 74)}`;
    const amount = BigInt(`0x${data.slice(74, 138)}`);
    changes.push({ type: "erc20_transfer", from: "unknown", to, amount });
  }

  return changes;
}

// ─── Slippage Estimation ──────────────────────────────────────────────────────

/**
 * Naively estimates slippage in basis points by comparing the largest
 * incoming and outgoing ERC-20 transfer amounts in the trace.
 * A proper DEX-aware implementation would decode pool reserves.
 */
function estimateSlippage(changes: StateChange[]): number | undefined {
  const transfers = changes.filter(c => c.type === "erc20_transfer" && c.amount !== undefined);
  if (transfers.length < 2) return undefined;

  // Sort descending by amount
  const sorted = transfers
    .map(c => c.amount as bigint)
    .sort((a, b) => (b > a ? 1 : -1));

  const high = sorted[0] ?? 0n;
  const low  = sorted[sorted.length - 1] ?? 0n;

  if (high === 0n) return undefined;

  // bps = (high - low) / high * 10_000
  return Number(((high - low) * 10_000n) / high);
}

// ─── Revert Reason Decoder ────────────────────────────────────────────────────

/** Exported for direct unit testing. */
export function decodeRevertReason(data?: string): string | undefined {
  if (!data || data === "0x") return undefined;

  // Standard Error(string) ABI encoding: selector 0x08c379a0
  if (data.startsWith("0x08c379a0")) {
    try {
      const offset  = parseInt(data.slice(10, 74), 16);
      const length  = parseInt(data.slice(10 + offset * 2, 10 + offset * 2 + 64), 16);
      const msgHex  = data.slice(10 + offset * 2 + 64, 10 + offset * 2 + 64 + length * 2);
      return Buffer.from(msgHex, "hex").toString("utf8");
    } catch {
      return undefined;
    }
  }

  return undefined;
}
