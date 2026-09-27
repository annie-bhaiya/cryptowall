/**
 * tests/unit/policy.test.ts
 *
 * Unit tests for PolicyEngine — strict / permissive / audit modes,
 * custom threshold overrides, and alwaysBlock / neverBlock category logic.
 */

import { describe, it, expect } from "@jest/globals";
import { PolicyEngine } from "../../src/policy.js";
import type { CircuitBreakerConfig, DecisionMatrix, TransactionPayload } from "../../src/types.js";
import { BENIGN_TX_PAYLOAD, MALICIOUS_TX_PAYLOAD } from "../fixtures/transactions.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<DecisionMatrix> = {}): DecisionMatrix {
  return {
    risk_category:       "normal",
    risk_flags:          ["normal"],
    exploit_probability: 0.1,
    severity_score:      1,
    rationale:           "test decision",
    decided_at:          Date.now(),
    ...overrides,
  };
}

function makeEngine(policy: CircuitBreakerConfig["policy"], thresholds?: Partial<CircuitBreakerConfig["thresholds"]>): PolicyEngine {
  return new PolicyEngine({
    rpcUrl:     "http://127.0.0.1:8546",
    policy,
    jevApiKey:  "test",
    thresholds: thresholds ?? undefined,
  });
}

const TX: TransactionPayload = BENIGN_TX_PAYLOAD;

// ─── Strict Mode ──────────────────────────────────────────────────────────────

describe("PolicyEngine — strict mode", () => {
  const engine = makeEngine("strict");

  it("blocks when exploit_probability > 0.70", () => {
    const v = engine.evaluate(makeDecision({ exploit_probability: 0.94, severity_score: 2, risk_category: "unverified_calldata", risk_flags: ["unverified_calldata"] }), TX);
    expect(v.action).toBe("block");
    expect(v.reason).toContain("probability");
  });

  it("blocks when severity_score >= 4", () => {
    const v = engine.evaluate(makeDecision({ exploit_probability: 0.50, severity_score: 4, risk_category: "unverified_calldata", risk_flags: ["unverified_calldata"] }), TX);
    expect(v.action).toBe("block");
    expect(v.reason).toContain("Severity");
  });

  it("always blocks malicious_approval regardless of probability", () => {
    const v = engine.evaluate(makeDecision({
      risk_category: "malicious_approval",
      risk_flags:    ["malicious_approval"],
      exploit_probability: 0.1,  // low — but alwaysBlockCategories overrides
      severity_score: 1,
    }), TX);
    expect(v.action).toBe("block");
    expect(v.reason).toContain("always blocked");
  });

  it("always blocks poison_token", () => {
    const v = engine.evaluate(makeDecision({ risk_category: "poison_token", risk_flags: ["poison_token"], exploit_probability: 0.1, severity_score: 1 }), TX);
    expect(v.action).toBe("block");
  });

  it("always blocks reentrancy_risk", () => {
    const v = engine.evaluate(makeDecision({ risk_category: "reentrancy_risk", risk_flags: ["reentrancy_risk"], exploit_probability: 0.1, severity_score: 1 }), TX);
    expect(v.action).toBe("block");
  });

  it("allows a clean benign transaction", () => {
    const v = engine.evaluate(makeDecision({ exploit_probability: 0.05, severity_score: 1 }), TX);
    expect(v.action).toBe("allow");
  });

  it("warns for unverified_calldata at 0.50 probability (warn zone, below 0.70 threshold)", () => {
    const v = engine.evaluate(makeDecision({
      risk_category: "unverified_calldata",
      risk_flags:    ["unverified_calldata"],
      exploit_probability: 0.50,
      severity_score: 2,
    }), TX);
    // 0.50 > 0.70 * 0.6 = 0.42 → warn zone
    // unverified_calldata is not in alwaysBlockCategories → warn, not block
    expect(v.action).toBe("warn");
  });

  it("allows normal at exactly 0.42 probability (at warn threshold boundary)", () => {
    const v = engine.evaluate(makeDecision({ exploit_probability: 0.42, severity_score: 1, risk_category: "normal", risk_flags: ["normal"] }), TX);
    expect(v.action).toBe("allow");
  });
});

// ─── Permissive Mode ──────────────────────────────────────────────────────────

describe("PolicyEngine — permissive mode", () => {
  const engine = makeEngine("permissive");

  it("allows at 0.72 probability (below 0.92 threshold)", () => {
    // sandwich_exposure is NOT in permissive alwaysBlockCategories
    const v = engine.evaluate(makeDecision({ exploit_probability: 0.72, severity_score: 3, risk_category: "sandwich_exposure", risk_flags: ["sandwich_exposure"] }), TX);
    expect(v.action).not.toBe("block");
  });

  it("blocks when exploit_probability > 0.92", () => {
    const v = engine.evaluate(makeDecision({ exploit_probability: 0.95, severity_score: 2, risk_category: "sandwich_exposure", risk_flags: ["sandwich_exposure"] }), TX);
    expect(v.action).toBe("block");
  });

  it("always blocks poison_token (in permissive alwaysBlockCategories)", () => {
    const v = engine.evaluate(makeDecision({ risk_category: "poison_token", risk_flags: ["poison_token"], exploit_probability: 0.1, severity_score: 1 }), TX);
    expect(v.action).toBe("block");
  });

  it("never blocks unverified_calldata (in permissive neverBlockCategories)", () => {
    const v = engine.evaluate(makeDecision({ risk_category: "unverified_calldata", risk_flags: ["unverified_calldata"], exploit_probability: 0.95, severity_score: 5 }), TX);
    // neverBlock overrides probability + severity — still won't block primary category
    expect(v.action).not.toBe("block");
  });
});

// ─── Audit Mode ───────────────────────────────────────────────────────────────

describe("PolicyEngine — audit mode", () => {
  const engine = makeEngine("audit");

  it("never blocks — returns allow or warn for any input", () => {
    const scenarios: Array<Partial<DecisionMatrix>> = [
      { risk_category: "malicious_approval", exploit_probability: 0.99, severity_score: 5 },
      { risk_category: "poison_token",       exploit_probability: 0.99, severity_score: 5 },
      { risk_category: "sandwich_exposure",  exploit_probability: 0.99, severity_score: 5 },
      { risk_category: "normal",             exploit_probability: 0.01, severity_score: 1 },
    ];
    for (const s of scenarios) {
      const v = engine.evaluate(makeDecision({ ...s, risk_flags: [s.risk_category ?? "normal"] }), TX);
      expect(v.action).not.toBe("block");
    }
  });
});

// ─── Custom Threshold Override ────────────────────────────────────────────────

describe("PolicyEngine — custom threshold override", () => {
  it("blocks at 0.50 when exploitProbabilityThreshold is overridden to 0.40", () => {
    const engine = makeEngine("strict", { exploitProbabilityThreshold: 0.40 });
    const v = engine.evaluate(makeDecision({
      exploit_probability: 0.50,
      severity_score: 2,
      risk_category: "unverified_calldata",
      risk_flags: ["unverified_calldata"],
    }), TX);
    expect(v.action).toBe("block");
    expect(v.reason).toContain("40%");
  });

  it("exposes the resolved thresholds via activeThresholds", () => {
    const engine = makeEngine("strict", { exploitProbabilityThreshold: 0.40 });
    expect(engine.activeThresholds.exploitProbabilityThreshold).toBe(0.40);
    // Other strict defaults preserved
    expect(engine.activeThresholds.alwaysBlockCategories).toContain("malicious_approval");
  });
});

// ─── Callback hooks ───────────────────────────────────────────────────────────

describe("PolicyEngine — onDecision / onBlock hooks", () => {
  it("calls onDecision for every evaluate() call", () => {
    const decisions: unknown[] = [];
    const engine = new PolicyEngine({
      rpcUrl: "http://127.0.0.1:8546", policy: "strict", jevApiKey: "test",
      onDecision: (d) => decisions.push(d),
    });
    engine.evaluate(makeDecision(), TX);
    expect(decisions).toHaveLength(1);
  });

  it("calls onBlock only when action is block", () => {
    const blocked: unknown[] = [];
    const engine = new PolicyEngine({
      rpcUrl: "http://127.0.0.1:8546", policy: "strict", jevApiKey: "test",
      onBlock: (d) => blocked.push(d),
    });
    engine.evaluate(makeDecision({ exploit_probability: 0.95, severity_score: 2, risk_category: "unverified_calldata", risk_flags: ["unverified_calldata"] }), TX);
    expect(blocked).toHaveLength(1);
  });

  it("does NOT call onBlock when action is allow", () => {
    const blocked: unknown[] = [];
    const engine = new PolicyEngine({
      rpcUrl: "http://127.0.0.1:8546", policy: "strict", jevApiKey: "test",
      onBlock: (d) => blocked.push(d),
    });
    engine.evaluate(makeDecision({ exploit_probability: 0.05 }), TX);
    expect(blocked).toHaveLength(0);
  });
});

// ─── Malicious TX payload through PolicyEngine ────────────────────────────────

describe("PolicyEngine — malicious TX payload", () => {
  it("strict: blocks malicious TX via alwaysBlock category", () => {
    const engine = makeEngine("strict");
    const decision = makeDecision({
      risk_category: "malicious_approval",
      risk_flags: ["malicious_approval"],
      exploit_probability: 0.94,
      severity_score: 4,
    });
    const verdict = engine.evaluate(decision, MALICIOUS_TX_PAYLOAD);
    expect(verdict.action).toBe("block");
  });
});
