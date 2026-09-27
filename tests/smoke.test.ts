/**
 * Smoke test — verifies Jest + ts-jest ESM config is working.
 * Deleted after the full suite is confirmed working.
 */
import { describe, it, expect } from "@jest/globals";

describe("jest smoke test", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
