/**
 * Policy Engine
 *
 * Evaluates a DecisionMatrix against a PolicyMode and returns a typed
 * PolicyVerdict — the single source of truth for whether a transaction
 * is blocked, warned, or allowed through the proxy.
 *
 * All threshold logic is centralised here so the proxy and SDK transport
 * both gate identically.
 */

import type {
  CircuitBreakerConfig,
  DecisionMatrix,
  PolicyMode,
  PolicyThresholds,
  RiskCategory,
  TransactionPayload,
} from "./types.js";

// ─── Verdict ──────────────────────────────────────────────────────────────────

export type VerdictAction = "block" | "warn" | "allow";

export interface PolicyVerdict {
  action:   VerdictAction;
  decision: DecisionMatrix;
  /** Human-readable reason when action is "block" */
  reason?:  string | undefined;
}

// ─── Default Thresholds per Policy Mode ──────────────────────────────────────

const STRICT_DEFAULTS: PolicyThresholds = {
  exploitProbabilityThreshold: 0.70,
  minSeverityToBlock:          4,
  alwaysBlockCategories:       ["malicious_approval", "poison_token", "reentrancy_risk"],
  neverBlockCategories:        [],
};

const PERMISSIVE_DEFAULTS: PolicyThresholds = {
  exploitProbabilityThreshold: 0.92,
  minSeverityToBlock:          5,
  alwaysBlockCategories:       ["poison_token"],
  neverBlockCategories:        ["unverified_calldata"],
};

const AUDIT_DEFAULTS: PolicyThresholds = {
  exploitProbabilityThreshold: Infinity, // never blocks
  minSeverityToBlock:          5,
  alwaysBlockCategories:       [],
  neverBlockCategories:        [
    "sandwich_exposure",
    "malicious_approval",
    "unverified_calldata",
    "bad_debt_risk",
    "poison_token",
    "reentrancy_risk",
    "price_manipulation",
    "normal",
  ],
};

const BASE_THRESHOLDS: Record<PolicyMode, PolicyThresholds> = {
  strict:     STRICT_DEFAULTS,
  permissive: PERMISSIVE_DEFAULTS,
  audit:      AUDIT_DEFAULTS,
};

// ─── Policy Engine ────────────────────────────────────────────────────────────

export class PolicyEngine {
  private readonly mode:       PolicyMode;
  private readonly thresholds: PolicyThresholds;
  private readonly onDecision?: CircuitBreakerConfig["onDecision"];
  private readonly onBlock?:    CircuitBreakerConfig["onBlock"];

  constructor(config: CircuitBreakerConfig) {
    this.mode       = config.policy;
    this.onDecision = config.onDecision;
    this.onBlock    = config.onBlock;

    // Merge caller overrides onto the base defaults for the chosen mode
    const base = BASE_THRESHOLDS[config.policy];
    this.thresholds = config.thresholds
      ? { ...base, ...config.thresholds }
      : base;
  }

  /**
   * Evaluate a DecisionMatrix and produce a PolicyVerdict.
   * Always fires onDecision callback before returning.
   * Fires onBlock callback when action is "block".
   */
  evaluate(decision: DecisionMatrix, tx: TransactionPayload): PolicyVerdict {
    const verdict = this.computeVerdict(decision);

    this.onDecision?.(decision, tx);

    if (verdict.action === "block") {
      this.onBlock?.(decision, tx);
    }

    return verdict;
  }

  private computeVerdict(decision: DecisionMatrix): PolicyVerdict {
    const t = this.thresholds;

    // --- always-block categories override everything ---
    if (this.mode !== "audit") {
      for (const flag of decision.risk_flags) {
        if (
          t.alwaysBlockCategories.includes(flag) &&
          !t.neverBlockCategories.includes(flag)
        ) {
          return {
            action:   "block",
            decision,
            reason:   `Category "${flag}" is always blocked in ${this.mode} mode.`,
          };
        }
      }
    }

    // --- never-block overrides: if primary category is never-blocked ---
    if (t.neverBlockCategories.includes(decision.risk_category)) {
      return {
        action:   decision.exploit_probability > 0.5 ? "warn" : "allow",
        decision,
      };
    }

    // --- probability threshold gate ---
    if (decision.exploit_probability > t.exploitProbabilityThreshold) {
      return {
        action:   "block",
        decision,
        reason:   `Exploit probability ${(decision.exploit_probability * 100).toFixed(1)}% exceeds ${(t.exploitProbabilityThreshold * 100).toFixed(0)}% threshold.`,
      };
    }

    // --- severity threshold gate ---
    if (decision.severity_score >= t.minSeverityToBlock) {
      return {
        action:   "block",
        decision,
        reason:   `Severity score ${decision.severity_score}/5 meets blocking threshold (≥${t.minSeverityToBlock}).`,
      };
    }

    // --- warn zone: elevated risk but below blocking threshold ---
    const warnProbThreshold = t.exploitProbabilityThreshold * 0.6;
    if (
      decision.exploit_probability > warnProbThreshold ||
      decision.risk_category !== "normal"
    ) {
      return { action: "warn", decision };
    }

    return { action: "allow", decision };
  }

  get policyMode(): PolicyMode {
    return this.mode;
  }

  get activeThresholds(): PolicyThresholds {
    return this.thresholds;
  }
}

// ─── Build helpers ────────────────────────────────────────────────────────────

/**
 * Resolves the effective thresholds for a given mode, applying any overrides.
 * Exported for introspection / testing.
 */
export function resolveThresholds(
  mode: PolicyMode,
  overrides?: Partial<PolicyThresholds>
): PolicyThresholds {
  const base = BASE_THRESHOLDS[mode];
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    alwaysBlockCategories: mergeCategories(
      base.alwaysBlockCategories,
      overrides.alwaysBlockCategories
    ),
    neverBlockCategories: mergeCategories(
      base.neverBlockCategories,
      overrides.neverBlockCategories
    ),
  };
}

function mergeCategories(
  base: RiskCategory[],
  override?: RiskCategory[]
): RiskCategory[] {
  if (!override) return base;
  const merged = new Set([...base, ...override]);
  return Array.from(merged);
}
