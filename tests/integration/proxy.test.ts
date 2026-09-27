/**
 * tests/integration/proxy.test.ts
 *
 * End-to-end integration tests for the CircuitBreaker-AI JSON-RPC proxy.
 *
 * Pipeline tested per request:
 *   HTTP → Fastify → parse → SimulationEngine → JevClient → PolicyEngine → block|warn|allow
 *
 * MSW intercepts both the JEV AI endpoint and the upstream RPC so tests run
 * fully offline. Set ANVIL=1 to run against a real Anvil node on :8546.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { startTestProxy, type TestProxy } from "../helpers/proxy.js";
import {
  sendRpc, sendRawTx, sendUserOp, sendBatch,
  getHealth, getPolicy,
  isBlocked, isAllowed, getDecision,
} from "../helpers/rpc.js";
import { mockServer, setJevResponse, resetJevResponse } from "../mocks/server.js";
import {
  BENIGN_RAW_TX,
  MALICIOUS_RAW_TX,
  MALICIOUS_USER_OP,
} from "../fixtures/transactions.js";

// ─── Suite Setup ──────────────────────────────────────────────────────────────

let proxy: TestProxy;

beforeAll(async () => {
  mockServer.listen({ onUnhandledRequest(req, print) { const u = new URL(req.url); if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return; print.warning(); } });
  proxy = await startTestProxy();
}, 15_000);

afterEach(() => {
  mockServer.resetHandlers();
  resetJevResponse();
});

afterAll(async () => {
  await proxy.close();
  mockServer.close();
});

// ─── 1. Health & Info Routes ──────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns status ok with policy info", async () => {
    const res = await getHealth(proxy.url);
    expect(res["status"]).toBe("ok");
    expect(res["version"]).toBe("1.0.0");
    expect(res["policy"]).toBe("strict");
    expect(res["sdk"]).toBe("@breaker/viem-middleware");
  });
});

describe("GET /policy", () => {
  it("returns strict mode thresholds", async () => {
    const res = await getPolicy(proxy.url);
    expect(res["mode"]).toBe("strict");
    const t = res["thresholds"] as Record<string, unknown>;
    expect(t["exploitProbabilityThreshold"]).toBe(0.70);
    expect(t["minSeverityToBlock"]).toBe(4);
    expect(t["alwaysBlockCategories"]).toContain("malicious_approval");
  });
});

// ─── 2. Benign ERC-20 Transfer — should pass through ─────────────────────────

describe("eth_sendRawTransaction — benign transfer", () => {
  it("allows a standard ERC-20 transfer and returns a tx hash", async () => {
    setJevResponse("benign");
    const res = await sendRawTx(proxy.url, BENIGN_RAW_TX);

    expect(isAllowed(res)).toBe(true);
    expect(typeof res.result).toBe("string");
    expect((res.result as string).startsWith("0x")).toBe(true);
  });
});

// ─── 3. Malicious Approval — strict mode block ────────────────────────────────

describe("eth_sendRawTransaction — malicious MAX_UINT256 approval (strict mode)", () => {
  it("blocks the transaction with code -32003", async () => {
    setJevResponse("malicious");
    const res = await sendRawTx(proxy.url, MALICIOUS_RAW_TX);

    expect(isBlocked(res)).toBe(true);
    expect(res.error?.code).toBe(-32003);
    expect(res.error?.message).toContain("[CircuitBreaker-AI]");
  });

  it("returns a typed DecisionMatrix in error.data.decision", async () => {
    setJevResponse("malicious");
    const res = await sendRawTx(proxy.url, MALICIOUS_RAW_TX);

    const decision = getDecision(res);
    expect(decision).toBeDefined();
    expect(decision?.["risk_category"]).toBe("malicious_approval");
    expect(decision?.["exploit_probability"]).toBeGreaterThanOrEqual(0.7);
    expect(decision?.["severity_score"]).toBeGreaterThanOrEqual(4);
    expect(typeof decision?.["rationale"]).toBe("string");
  });
});

// ─── 4. Audit Mode — never blocks ─────────────────────────────────────────────

describe("eth_sendRawTransaction — audit mode", () => {
  let auditProxy: TestProxy;

  beforeAll(async () => {
    auditProxy = await startTestProxy({ POLICY_MODE: "audit" });
  }, 10_000);

  afterAll(async () => {
    await auditProxy.close();
  });

  it("does NOT block a malicious approval in audit mode", async () => {
    setJevResponse("malicious");
    const res = await sendRawTx(auditProxy.url, MALICIOUS_RAW_TX);

    // Audit mode never blocks — should have result, not an error
    expect(isBlocked(res)).toBe(false);
    expect(res.result).toBeDefined();
  });
});

// ─── 5. Permissive Mode — higher threshold ────────────────────────────────────

describe("eth_sendRawTransaction — permissive mode", () => {
  let permProxy: TestProxy;

  beforeAll(async () => {
    permProxy = await startTestProxy({ POLICY_MODE: "permissive" });
  }, 10_000);

  afterAll(async () => {
    await permProxy.close();
  });

  it("does NOT block a sandwich_exposure at 0.72 probability (below 0.92 threshold)", async () => {
    // sandwich_exposure is NOT in permissive alwaysBlockCategories
    // probability 0.72 < permissive threshold 0.92 → allow
    setJevResponse("sandwich");
    const res = await sendRawTx(permProxy.url, BENIGN_RAW_TX);

    expect(isBlocked(res)).toBe(false);
    expect(res.result).toBeDefined();
  });
});

// ─── 6. Heuristic Fallback — JEV API unavailable ─────────────────────────────

describe("blocks malicious approval via heuristic fallback when JEV API times out", () => {
  it("detects MAX_UINT256 pattern locally when JEV API exceeds ANALYSIS_TIMEOUT_MS", async () => {
    // MSW will delay 1400ms > 800ms timeout → AbortError → heuristicFallback()
    // heuristicFallback detects 0x095ea7b3...fff → malicious_approval, prob=0.72, severity=4
    // strict alwaysBlockCategories includes malicious_approval → BLOCKED
    setJevResponse("timeout");

    const res = await sendRawTx(proxy.url, MALICIOUS_RAW_TX);

    expect(isBlocked(res)).toBe(true);
    expect(res.error?.code).toBe(-32003);

    const decision = getDecision(res);
    expect(decision?.["risk_category"]).toBe("malicious_approval");
    // Heuristic rationale contains the fallback message
    expect((decision?.["rationale"] as string)).toContain("Heuristic");
  }, 15_000); // extra timeout for the 1400ms MSW delay
});

// ─── 7. Non-send pass-through — zero analysis overhead ───────────────────────

describe("eth_blockNumber — non-send method pass-through", () => {
  it("passes through immediately with result, no decision overhead", async () => {
    const start = Date.now();
    const res = await sendRpc(proxy.url, "eth_blockNumber", []);
    const elapsed = Date.now() - start;

    expect(res.result).toBeDefined();
    expect(res.error).toBeUndefined();
    // Should resolve very fast — no simulation or JEV eval
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── 8. Batch JSON-RPC ────────────────────────────────────────────────────────

describe("batch JSON-RPC", () => {
  it("processes benign+malicious in one batch — benign allowed, malicious blocked", async () => {
    setJevResponse("auto"); // let MSW auto-detect per request

    const responses = await sendBatch(proxy.url, [
      { method: "eth_sendRawTransaction", params: [BENIGN_RAW_TX],    id: 10 },
      { method: "eth_sendRawTransaction", params: [MALICIOUS_RAW_TX], id: 11 },
    ]);

    expect(responses).toHaveLength(2);

    const benignRes   = responses.find(r => r.id === 10)!;
    const maliciousRes = responses.find(r => r.id === 11)!;

    expect(isAllowed(benignRes)).toBe(true);
    expect(isBlocked(maliciousRes)).toBe(true);
    expect(maliciousRes.error?.code).toBe(-32003);
  });
});

// ─── 9. UserOperation intercept (ERC-4337) ────────────────────────────────────

describe("eth_sendUserOperation — malicious callData blocked", () => {
  it("blocks a UserOperation with MAX_UINT256 approve callData", async () => {
    setJevResponse("malicious");
    const res = await sendUserOp(proxy.url, MALICIOUS_USER_OP);

    expect(isBlocked(res)).toBe(true);
    expect(res.error?.code).toBe(-32003);

    const decision = getDecision(res);
    expect(decision?.["risk_category"]).toBe("malicious_approval");
  });
});
