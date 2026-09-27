/**
 * tests/unit/simulation.test.ts
 *
 * Unit tests for SimulationEngine and exported helpers:
 *   - extractStateChangesFromCalldata() — direct unit tests
 *   - decodeRevertReason()              — direct unit tests
 *   - SimulationEngine.simulate()       — via MSW mock (integration path)
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "@jest/globals";
import {
  SimulationEngine,
  extractStateChangesFromCalldata,
  decodeRevertReason,
} from "../../src/simulation.js";
import { mockServer, resetJevResponse } from "../mocks/server.js";
import { mockServerNoTrace } from "../mocks/server.js";
import { BENIGN_TX_PAYLOAD, MALICIOUS_TX_PAYLOAD, BENIGN_CALLDATA, MALICIOUS_CALLDATA } from "../fixtures/transactions.js";

// ─── extractStateChangesFromCalldata() ───────────────────────────────────────

describe("extractStateChangesFromCalldata() — ERC-20 transfer", () => {
  it("parses transfer(address,uint256) into erc20_transfer state change", () => {
    const changes = extractStateChangesFromCalldata(BENIGN_CALLDATA);

    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.type).toBe("erc20_transfer");
    expect(c.to?.toLowerCase()).toContain("70997970");  // recipient suffix
    expect(c.amount).toBe(1000000n);                    // 0xf4240 = 1,000,000
  });
});

describe("extractStateChangesFromCalldata() — ERC-20 MAX_UINT256 approve", () => {
  it("parses approve(address,uint256=MAX) into erc20_approval with unlimited token marker", () => {
    const changes = extractStateChangesFromCalldata(MALICIOUS_CALLDATA);

    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.type).toBe("erc20_approval");
    expect(c.spender?.toLowerCase()).toContain("deadbeef");
    // Unlimited approval sentinel
    expect(c.token).toBe("unlimited");
    // Amount = MAX_UINT256
    expect(c.amount).toBe(2n ** 256n - 1n);
  });
});

describe("extractStateChangesFromCalldata() — unknown selector", () => {
  it("returns empty array for unrecognised calldata", () => {
    const changes = extractStateChangesFromCalldata("0xdeadbeef" + "00".repeat(64));
    expect(changes).toHaveLength(0);
  });

  it("returns empty array for empty data", () => {
    const changes = extractStateChangesFromCalldata("0x");
    expect(changes).toHaveLength(0);
  });
});

// ─── decodeRevertReason() ─────────────────────────────────────────────────────

describe("decodeRevertReason() — standard Error(string)", () => {
  it("decodes ABI-encoded Error('insufficient balance')", () => {
    // ABI encoding of Error("insufficient balance")
    // "insufficient balance" = 20 chars = 0x14 bytes
    // hex: 696e73756666696369656e742062616c616e6365 (20 bytes / 40 hex chars)
    const encoded =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" + // offset = 32
      "0000000000000000000000000000000000000000000000000000000000000014" + // length = 20
      "696e73756666696369656e742062616c616e63650000000000000000000000000000000000000000000000000000000000"; // padded to 32 bytes

    const reason = decodeRevertReason(encoded);
    expect(reason).toBe("insufficient balance");
  });

  it("returns undefined for 0x (no revert data)", () => {
    expect(decodeRevertReason("0x")).toBeUndefined();
  });

  it("returns undefined for empty / undefined input", () => {
    expect(decodeRevertReason(undefined)).toBeUndefined();
    expect(decodeRevertReason("")).toBeUndefined();
  });

  it("returns undefined for unrecognised selector", () => {
    // Panic(uint256) uses selector 0x4e487b71 — not the standard Error(string)
    const panicData = "0x4e487b71" + "00".repeat(32);
    expect(decodeRevertReason(panicData)).toBeUndefined();
  });
});

// ─── SimulationEngine.simulate() — via MSW debug_traceCall ───────────────────

describe("SimulationEngine.simulate() — with debug_traceCall", () => {
  beforeAll(() => mockServer.listen({ onUnhandledRequest: "warn" }));
  afterEach(() => { mockServer.resetHandlers(); resetJevResponse(); });
  afterAll(() => mockServer.close());

  it("returns a SimulationTrace with state changes for a benign transfer", async () => {
    const engine = new SimulationEngine("http://127.0.0.1:8546");
    const trace  = await engine.simulate(BENIGN_TX_PAYLOAD);

    expect(trace.reverted).toBe(false);
    expect(typeof trace.gas_used).toBe("bigint");
    // The mock returns an empty calls array but non-reverted
    expect(trace.state_changes).toBeDefined();
    expect(Array.isArray(trace.call_trace)).toBe(true);
  });
});

// ─── SimulationEngine.simulate() — eth_call fallback ────────────────────────

describe("SimulationEngine.simulate() — falls back to eth_call when debug_traceCall unavailable", () => {
  beforeAll(() => mockServerNoTrace.listen({ onUnhandledRequest: "warn" }));
  afterEach(() => mockServerNoTrace.resetHandlers());
  afterAll(() => mockServerNoTrace.close());

  it("returns a SimulationTrace via eth_call fallback when trace not supported", async () => {
    const engine = new SimulationEngine("http://127.0.0.1:8546");
    const trace  = await engine.simulate(BENIGN_TX_PAYLOAD);

    // eth_call returns 0x (no revert) → not reverted
    expect(trace.reverted).toBe(false);
    // call_trace is empty (no trace data)
    expect(trace.call_trace).toHaveLength(0);
  });

  it("parses state changes from calldata when trace is unavailable (malicious approve)", async () => {
    const engine = new SimulationEngine("http://127.0.0.1:8546");
    const trace  = await engine.simulate(MALICIOUS_TX_PAYLOAD);

    // The eth_call fallback extracts state changes from calldata directly
    expect(trace.state_changes.length).toBeGreaterThan(0);
    const approval = trace.state_changes.find(c => c.type === "erc20_approval");
    expect(approval).toBeDefined();
    expect(approval?.spender?.toLowerCase()).toContain("deadbeef");
  });
});
