/**
 * tests/fixtures/jev-responses.ts
 *
 * Canned JEV AI API response bodies for MSW mock handler.
 * Shape mirrors JevResponse wire type from src/jevClient.ts.
 */

// ─── Benign — normal transfer, no threats ─────────────────────────────────────

export const BENIGN_JEV_RESPONSE = {
  decisions: {
    risk_category:       { choice: "normal" },
    risk_flags:          { choices: ["normal"] },
    exploit_probability: { probability: 0.05 },
    severity_score:      { score: 1 },
    rationale:           { text: "Standard ERC-20 transfer to known recipient. No anomalies detected." },
  },
  model:      "jev-rlcd-v2",
  latency_ms: 42,
};

// ─── Malicious — MAX_UINT256 approval, phishing drainer ──────────────────────

export const MALICIOUS_JEV_RESPONSE = {
  decisions: {
    risk_category:       { choice: "malicious_approval" },
    risk_flags:          { choices: ["malicious_approval"] },
    exploit_probability: { probability: 0.94 },
    severity_score:      { score: 4 },
    rationale:           { text: "Unlimited ERC-20 approval (MAX_UINT256) to unverified spender 0xDeaDBeef. Classic phishing drainer pattern." },
  },
  model:      "jev-rlcd-v2",
  latency_ms: 38,
};

// ─── Warn — elevated risk but below blocking threshold ───────────────────────

export const WARN_JEV_RESPONSE = {
  decisions: {
    risk_category:       { choice: "unverified_calldata" },
    risk_flags:          { choices: ["unverified_calldata"] },
    exploit_probability: { probability: 0.45 },
    severity_score:      { score: 2 },
    rationale:           { text: "Target contract is unverified. Risk elevated but below blocking threshold." },
  },
  model:      "jev-rlcd-v2",
  latency_ms: 51,
};

// ─── Permissive-zone malicious — blocked in strict, allowed in permissive ─────
// exploit_probability = 0.72 → above strict threshold (0.70), below permissive (0.92)
// BUT risk_category = malicious_approval is in strict alwaysBlockCategories
// So we use sandwich_exposure for the permissive pass-through test instead

export const SANDWICH_JEV_RESPONSE = {
  decisions: {
    risk_category:       { choice: "sandwich_exposure" },
    risk_flags:          { choices: ["sandwich_exposure"] },
    exploit_probability: { probability: 0.72 },
    severity_score:      { score: 3 },
    rationale:           { text: "Potential sandwich exposure: 3 identical swaps in same block with 312bps slippage." },
  },
  model:      "jev-rlcd-v2",
  latency_ms: 45,
};
