/**
 * @breaker/viem-middleware — UserOperation Interceptor
 *
 * Provides a standalone interceptor for ERC-4337 UserOperations, usable
 * independently of the viem transport layer.  Designed for:
 *   - Smart account SDKs (permissionless.js, ZeroDev, Biconomy)
 *   - Automated liquidators using AA wallets
 *   - Cross-chain intent bridges that batch UserOperations
 *
 * Usage:
 * ```ts
 * const interceptor = createUserOperationInterceptor(config);
 * const safe = await interceptor.inspect(userOp);
 * // safe.decision is a typed DecisionMatrix
 * // safe.approved → boolean (false = blocked by policy)
 * ```
 */

import { JevClient } from "../jevClient.js";
import { PolicyEngine } from "../policy.js";
import { SimulationEngine } from "../simulation.js";
import type {
  CircuitBreakerConfig,
  DecisionMatrix,
  TransactionPayload,
  UserOperation,
} from "../types.js";

// ─── Inspection Result ────────────────────────────────────────────────────────

export interface UserOperationInspection {
  /** The original UserOperation */
  userOp:    UserOperation;
  /** Typed decision matrix from the analysis pipeline */
  decision:  DecisionMatrix;
  /** true if policy allows submission; false if blocked */
  approved:  boolean;
  /** Reason string when approved = false */
  reason?:   string | undefined;
  /** Round-trip latency in ms for the full analysis pipeline */
  latency_ms: number;
}

// ─── Batch Inspection Result ──────────────────────────────────────────────────

export interface BatchInspectionResult {
  /** Individual inspection per UserOperation */
  inspections: UserOperationInspection[];
  /** How many were approved */
  approved_count: number;
  /** How many were blocked */
  blocked_count: number;
  /** Total pipeline latency in ms */
  total_latency_ms: number;
}

// ─── Interceptor ─────────────────────────────────────────────────────────────

export class UserOperationInterceptor {
  private readonly jev:       JevClient;
  private readonly simulator: SimulationEngine;
  private readonly policy:    PolicyEngine;
  private readonly timeoutMs: number;

  constructor(config: CircuitBreakerConfig) {
    this.jev       = new JevClient(config.jevEndpoint, config.jevApiKey);
    this.simulator = new SimulationEngine(config.rpcUrl);
    this.policy    = new PolicyEngine(config);
    this.timeoutMs = config.analysisTimeoutMs ?? 800;
  }

  /**
   * Inspect a single UserOperation.  Returns a typed inspection result
   * with the full DecisionMatrix regardless of policy verdict.
   */
  async inspect(userOp: UserOperation): Promise<UserOperationInspection> {
    const start = Date.now();
    const tx    = this.userOpToPayload(userOp);

    const simulation = await withTimeout(
      this.simulator.simulate(tx),
      this.timeoutMs,
      undefined
    );

    const decision = await this.jev.evaluate(tx, simulation, this.timeoutMs);
    const verdict  = this.policy.evaluate(decision, tx);

    return {
      userOp,
      decision,
      approved:   verdict.action !== "block",
      reason:     verdict.reason,
      latency_ms: Date.now() - start,
    };
  }

  /**
   * Inspect a batch of UserOperations in parallel.
   * Returns per-op decisions and aggregate counts.
   * Useful for liquidation bots processing multiple positions simultaneously.
   */
  async inspectBatch(userOps: UserOperation[]): Promise<BatchInspectionResult> {
    const start       = Date.now();
    const inspections = await Promise.all(userOps.map(op => this.inspect(op)));

    return {
      inspections,
      approved_count:   inspections.filter(i => i.approved).length,
      blocked_count:    inspections.filter(i => !i.approved).length,
      total_latency_ms: Date.now() - start,
    };
  }

  /**
   * Filter a batch: returns only the approved UserOperations.
   * Drop-in for any AA bundler queue.
   */
  async filter(userOps: UserOperation[]): Promise<UserOperation[]> {
    const result = await this.inspectBatch(userOps);
    return result.inspections
      .filter(i => i.approved)
      .map(i => i.userOp);
  }

  /**
   * Assert a single UserOperation is approved.
   * Throws CircuitBreakerBlockedError if the policy blocks it.
   * Use in wallets where you want the signing flow to abort on block.
   */
  async assert(userOp: UserOperation): Promise<DecisionMatrix> {
    const inspection = await this.inspect(userOp);
    if (!inspection.approved) {
      const { CircuitBreakerBlockedError } = await import("./transport.js");
      throw new CircuitBreakerBlockedError(
        inspection.decision,
        inspection.reason ?? "Transaction blocked by policy"
      );
    }
    return inspection.decision;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private userOpToPayload(userOp: UserOperation): TransactionPayload {
    return {
      from:  userOp.sender,
      to:    decodeExecuteTarget(userOp.callData) ?? userOp.sender,
      data:  userOp.callData,
      value: "0",
      gas:   userOp.callGasLimit,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createUserOperationInterceptor(
  config: CircuitBreakerConfig
): UserOperationInterceptor {
  return new UserOperationInterceptor(config);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Decodes `execute(address,uint256,bytes)` selector 0xb61d27f6 */
function decodeExecuteTarget(callData: string): string | undefined {
  if (!callData.startsWith("0xb61d27f6") || callData.length < 74) return undefined;
  return `0x${callData.slice(34, 74)}`;
}

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
