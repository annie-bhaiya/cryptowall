/**
 * @breaker/viem-middleware — Core Type Definitions
 * Typed decision matrices for Web3 transaction risk analysis
 */

// ─── Risk Categories ──────────────────────────────────────────────────────────

export type RiskCategory =
  | "sandwich_exposure"   // MEV sandwich attack detected in simulation
  | "malicious_approval"  // ERC-20/721 approval to unverified/flagged spender
  | "unverified_calldata" // Calldata targets unknown/unverified contract
  | "bad_debt_risk"       // DeFi position opens under-collateralised debt
  | "poison_token"        // Interaction with known honeypot/exploit token
  | "reentrancy_risk"     // Simulation trace shows reentrancy pattern
  | "price_manipulation"  // Detected oracle or AMM price manipulation attempt
  | "normal";             // No threats detected

export type PolicyMode = "strict" | "permissive" | "audit";

// ─── Decision Matrix ──────────────────────────────────────────────────────────

/**
 * Calibrated decision matrix returned for every intercepted transaction.
 * Probabilities are true calibrated scores (0.0 – 1.0), not raw logits.
 */
export interface DecisionMatrix {
  /** Primary risk category with highest signal */
  risk_category: RiskCategory;
  /** All detected risk categories (may overlap) */
  risk_flags: RiskCategory[];
  /** Calibrated probability of exploit/harm (0.0 – 1.0) */
  exploit_probability: number;
  /** Severity score: 1 (informational) → 5 (critical) */
  severity_score: 1 | 2 | 3 | 4 | 5;
  /** Human-readable explanation of the decision */
  rationale: string;
  /** Simulation trace summary (present when trace was run) */
  simulation?: SimulationTrace | undefined;
  /** Timestamp of the decision in ms */
  decided_at: number;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

export interface SimulationTrace {
  /** Did the transaction revert during simulation? */
  reverted: boolean;
  /** Revert reason if applicable */
  revert_reason?: string | undefined;
  /** Estimated gas units consumed */
  gas_used: bigint;
  /** Detected state changes (ERC-20 transfers, approvals) */
  state_changes: StateChange[];
  /** Internal calls in execution trace */
  call_trace: CallFrame[];
  /** Slippage observed vs expected (basis points) */
  slippage_bps?: number | undefined;
}

export interface StateChange {
  type: "erc20_transfer" | "erc20_approval" | "eth_transfer" | "storage_write" | "nft_transfer";
  token?: string | undefined;      // Token contract address
  from?: string | undefined;
  to?: string | undefined;
  amount?: bigint | undefined;
  spender?: string | undefined;    // For approvals
  slot?: string | undefined;       // For storage writes
}

export interface CallFrame {
  from: string;
  to: string;
  value: bigint;
  input: string;
  output?: string | undefined;
  gas_used: bigint;
  depth: number;
  reverted: boolean;
  calls?: CallFrame[];
}

// ─── Transaction Payload ──────────────────────────────────────────────────────

export interface TransactionPayload {
  from: string;
  to: string;
  data: string;
  value: string;
  gas?: string | undefined;
  maxFeePerGas?: string | undefined;
  maxPriorityFeePerGas?: string | undefined;
  nonce?: number | undefined;
  chainId?: number | undefined;
}

// ─── ERC-4337 UserOperation ───────────────────────────────────────────────────

export interface UserOperation {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string;
  signature: string;
}

// ─── SDK Config ───────────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Upstream RPC URL (e.g. Alchemy, Infura, local node) */
  rpcUrl: string;
  /**
   * Policy mode:
   * - strict: block any tx with exploit_probability > 0.7 or severity >= 4
   * - permissive: block only exploit_probability > 0.92 or severity == 5
   * - audit: never block, emit warnings and decision matrix only
   */
  policy: PolicyMode;
  /** JEV AI endpoint (defaults to public CircuitBreaker endpoint) */
  jevEndpoint?: string;
  /** API key for JEV AI service */
  jevApiKey?: string;
  /** Override thresholds per-policy */
  thresholds?: Partial<PolicyThresholds>;
  /** Called on every decision — use for logging, metrics, telemetry */
  onDecision?: (decision: DecisionMatrix, tx: TransactionPayload) => void;
  /** Called when a transaction is blocked */
  onBlock?: (decision: DecisionMatrix, tx: TransactionPayload) => void;
  /** Timeout for simulation + AI analysis in ms (default: 800) */
  analysisTimeoutMs?: number;
}

export interface PolicyThresholds {
  /** Block if exploit_probability exceeds this */
  exploitProbabilityThreshold: number;
  /** Block if severity_score >= this value */
  minSeverityToBlock: 1 | 2 | 3 | 4 | 5;
  /** Specific categories that are always blocked regardless of score */
  alwaysBlockCategories: RiskCategory[];
  /** Specific categories that are never blocked (override) */
  neverBlockCategories: RiskCategory[];
}

// ─── Proxy Request / Response ─────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params: unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface BlockedTransactionError {
  code: -32003;
  message: string;
  data: {
    decision: DecisionMatrix;
  };
}
