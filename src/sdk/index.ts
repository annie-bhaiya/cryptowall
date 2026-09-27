/**
 * @breaker/viem-middleware
 *
 * Ultra-low latency middleware SDK for Web3 builders.
 * Intercepts, simulates, and AI-audits every transaction before it hits the
 * mempool — returning typed decision matrices, not unstructured text.
 *
 * One-liner integration:
 * ```ts
 * import { createCircuitBreakerClient } from "@breaker/viem-middleware";
 *
 * const client = createCircuitBreakerClient({
 *   rpcUrl: "https://mainnet.infura.io/v3/YOUR_KEY",
 *   policy: "strict",
 * });
 *
 * // Drop-in replacement for any viem WalletClient
 * const hash = await client.sendTransaction({ to, value, data });
 * ```
 */

import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type Client,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  CircuitBreakerBlockedError,
  createCircuitBreakerTransport,
} from "./transport.js";
import {
  createUserOperationInterceptor,
  UserOperationInterceptor,
} from "./userOperation.js";
import type { CircuitBreakerConfig } from "../types.js";

// ─── Re-exports for consumers ────────────────────────────────────────────────

export type {
  CircuitBreakerConfig,
  DecisionMatrix,
  PolicyMode,
  PolicyThresholds,
  RiskCategory,
  SimulationTrace,
  StateChange,
  CallFrame,
  TransactionPayload,
  UserOperation,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types.js";

export { CircuitBreakerBlockedError } from "./transport.js";
export {
  UserOperationInterceptor,
  createUserOperationInterceptor,
  type UserOperationInspection,
  type BatchInspectionResult,
} from "./userOperation.js";
export { createCircuitBreakerTransport } from "./transport.js";
export { JevClient } from "../jevClient.js";
export { PolicyEngine, resolveThresholds, type PolicyVerdict, type VerdictAction } from "../policy.js";
export { SimulationEngine } from "../simulation.js";

// ─── Client Factory ───────────────────────────────────────────────────────────

export interface CircuitBreakerClientOptions extends CircuitBreakerConfig {
  /** viem Chain object (e.g. mainnet, optimism, arbitrum from viem/chains) */
  chain?: Chain;
  /** viem Account for wallet operations (private key, mnemonic, etc.) */
  account?: Account;
}

/**
 * Creates a viem WalletClient + PublicClient pair wired through the
 * CircuitBreaker analysis pipeline.
 *
 * Every eth_sendRawTransaction and eth_sendUserOperation is intercepted:
 *   1. Simulated via debug_traceCall / eth_call
 *   2. Evaluated by JEV AI → typed DecisionMatrix
 *   3. Gated by PolicyEngine → block | warn | allow
 *
 * All read methods (eth_call, eth_getLogs, etc.) pass through at zero overhead.
 *
 * @throws {CircuitBreakerBlockedError} when policy blocks a transaction
 *
 * @example
 * ```ts
 * const client = createCircuitBreakerClient({
 *   rpcUrl: "https://mainnet.infura.io/v3/KEY",
 *   policy: "strict",
 *   onDecision: (d) => console.log(d.exploit_probability),
 * });
 *
 * try {
 *   await client.wallet.sendTransaction({ to: "0x...", value: parseEther("1") });
 * } catch (err) {
 *   if (err instanceof CircuitBreakerBlockedError) {
 *     console.log(err.decision.risk_category);   // "malicious_approval"
 *     console.log(err.decision.exploit_probability); // 0.94
 *   }
 * }
 * ```
 */
export function createCircuitBreakerClient(
  options: CircuitBreakerClientOptions
): CircuitBreakerClientResult {
  const transport = createCircuitBreakerTransport(options);

  const wallet: WalletClient = createWalletClient({
    account:   options.account,
    chain:     options.chain,
    transport,
  });

  const publicClient: PublicClient = createPublicClient({
    chain:     options.chain,
    transport,
  });

  const uoInterceptor = createUserOperationInterceptor(options);

  return {
    wallet,
    public:            publicClient,
    userOperations:    uoInterceptor,
    config:            options,
    /**
     * Inspect a raw transaction payload without sending it.
     * Returns the full DecisionMatrix for manual policy checks.
     */
    inspect: async (tx: {
      from?: string;
      to:    string;
      data?: string;
      value?: bigint;
    }) => {
      const { JevClient }        = await import("../jevClient.js");
      const { SimulationEngine } = await import("../simulation.js");
      const jev       = new JevClient(options.jevEndpoint, options.jevApiKey);
      const simulator = new SimulationEngine(options.rpcUrl);

      const payload = {
        from:  tx.from ?? "unknown",
        to:    tx.to,
        data:  tx.data ?? "0x",
        value: tx.value?.toString() ?? "0",
      };

      const simulation = await simulator.simulate(payload).catch(() => undefined);
      return jev.evaluate(payload, simulation, options.analysisTimeoutMs ?? 800);
    },
  };
}

// ─── Result Type ──────────────────────────────────────────────────────────────

export interface CircuitBreakerClientResult {
  /** viem WalletClient — use for sendTransaction, signMessage, etc. */
  wallet:         WalletClient;
  /** viem PublicClient — use for reads, simulations, gas estimation */
  public:         PublicClient;
  /** ERC-4337 UserOperation interceptor for AA wallets */
  userOperations: UserOperationInterceptor;
  /** Resolved config */
  config:         CircuitBreakerClientOptions;
  /**
   * Inspect a transaction payload and get a DecisionMatrix without sending.
   * Zero side-effects — useful for pre-signing UX warnings.
   */
  inspect(tx: {
    from?: string;
    to:    string;
    data?: string;
    value?: bigint;
  }): Promise<import("../types.js").DecisionMatrix>;
}

// ─── Default export for CJS / ESM compatibility ───────────────────────────────

export default createCircuitBreakerClient;
