/**
 * tests/unit/jevClient.test.ts
 *
 * Unit tests for JevClient — evaluate(), heuristicFallback(), timeout path.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "@jest/globals";
import { JevClient } from "../../src/jevClient.js";
import { mockServer, setJevResponse, resetJevResponse } from "../mocks/server.js";
import {
  BENIGN_TX_PAYLOAD,
  MALICIOUS_TX_PAYLOAD,
} from "../fixtures/transactions.js";
import type { SimulationTrace } from "../../src/types.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => mockServer.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { mockServer.resetHandlers(); resetJevResponse(); });
afterAll(() => mockServer.close());

const client = new JevClient(
  "https://api.typesafe.ai/v1/decide",
  "test-api-key-for-jest"
);

// ─── evaluate() — wired through MSW ──────────────────────────────────────────

describe("JevClient.evaluate() — benign transaction", () => {
  it("returns normal risk category with low probability", async () => {
    setJevResponse("benign");
    const decision = await client.evaluate(BENIGN_TX_PAYLOAD);

    expect(decision.risk_category).toBe("normal");
    expect(decision.exploit_probability).toBeLessThan(0.3);
    expect(decision.severity_score).toBe(1);
    expect(typeof decision.rationale).toBe("string");
    expect(decision.decided_at).toBeGreaterThan(0);
  });
});

describe("JevClient.evaluate() — malicious transaction", () => {
  it("returns malicious_approval with high probability", async () => {
    setJevResponse("malicious");
    const decision = await client.evaluate(MALICIOUS_TX_PAYLOAD);

    expect(decision.risk_category).toBe("malicious_approval");
    expect(decision.exploit_probability).toBeGreaterThan(0.9);
    expect(decision.severity_score).toBeGreaterThanOrEqual(4);
  });

  it("includes risk_flags array", async () => {
    setJevResponse("malicious");
    const decision = await client.evaluate(MALICIOUS_TX_PAYLOAD);

    expect(Array.isArray(decision.risk_flags)).toBe(true);
    expect(decision.risk_flags).toContain("malicious_approval");
  });
});

describe("JevClient.evaluate() — with simulation trace", () => {
  it("attaches simulation to the decision", async () => {
    setJevResponse("benign");
    const sim: SimulationTrace = {
      reverted:      false,
      gas_used:      21000n,
      state_changes: [],
      call_trace:    [],
    };
    const decision = await client.evaluate(BENIGN_TX_PAYLOAD, sim);

    expect(decision.simulation).toBeDefined();
    expect(decision.simulation?.reverted).toBe(false);
  });
});

// ─── evaluate() — timeout → heuristicFallback ────────────────────────────────

describe("JevClient.evaluate() — API timeout falls back to heuristics", () => {
  it("returns heuristic result when JEV API exceeds timeoutMs", async () => {
    setJevResponse("timeout"); // MSW delays 1400ms

    // Use a tight timeout so the test doesn't hang for 1.4s
    const decision = await client.evaluate(MALICIOUS_TX_PAYLOAD, undefined, 200);

    // heuristicFallback should detect MAX_UINT256 approve
    expect(decision.risk_category).toBe("malicious_approval");
    expect(decision.exploit_probability).toBeGreaterThanOrEqual(0.72);
    expect(decision.rationale).toContain("Heuristic");
  });
});

// ─── heuristicFallback() — direct tests ──────────────────────────────────────

describe("JevClient.heuristicFallback() — MAX_UINT256 approval", () => {
  it("detects phishing drainer pattern", () => {
    const decision = client.heuristicFallback(MALICIOUS_TX_PAYLOAD);

    expect(decision.risk_category).toBe("malicious_approval");
    expect(decision.exploit_probability).toBeCloseTo(0.72);
    expect(decision.severity_score).toBe(4);
    expect(decision.risk_flags).toContain("malicious_approval");
  });
});

describe("JevClient.heuristicFallback() — normal ERC-20 transfer", () => {
  it("returns normal with low probability", () => {
    const decision = client.heuristicFallback(BENIGN_TX_PAYLOAD);

    expect(decision.risk_category).toBe("normal");
    expect(decision.exploit_probability).toBe(0.1);
    expect(decision.severity_score).toBe(1);
  });
});

describe("JevClient.heuristicFallback() — reverted simulation", () => {
  it("raises probability when simulation reverts", () => {
    const sim: SimulationTrace = {
      reverted:      true,
      revert_reason: "execution reverted",
      gas_used:      0n,
      state_changes: [],
      call_trace:    [],
    };
    const decision = client.heuristicFallback(BENIGN_TX_PAYLOAD, sim);

    expect(decision.exploit_probability).toBeCloseTo(0.55);
    expect(decision.severity_score).toBeGreaterThanOrEqual(3);
  });
});

describe("JevClient.heuristicFallback() — high slippage", () => {
  it("detects potential sandwich attack", () => {
    const sim: SimulationTrace = {
      reverted:      false,
      gas_used:      100000n,
      state_changes: [],
      call_trace:    [],
      slippage_bps:  312, // > 200 bps threshold
    };
    const decision = client.heuristicFallback(BENIGN_TX_PAYLOAD, sim);

    expect(decision.risk_flags).toContain("sandwich_exposure");
    expect(decision.exploit_probability).toBeGreaterThanOrEqual(0.6);
  });
});
