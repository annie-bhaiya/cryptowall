/**
 * tests/mocks/jev-handler.ts
 *
 * MSW handler for the JEV AI decision endpoint.
 * Intercepts POST https://api.typesafe.ai/v1/decide
 *
 * The active response is controlled by `setJevResponse()`.
 * Default: "benign"
 */

import { http, HttpResponse, delay } from "msw";
import {
  BENIGN_JEV_RESPONSE,
  MALICIOUS_JEV_RESPONSE,
  WARN_JEV_RESPONSE,
  SANDWICH_JEV_RESPONSE,
} from "../fixtures/jev-responses.js";
import { MALICIOUS_CALLDATA } from "../fixtures/transactions.js";

export type JevResponseType = "benign" | "malicious" | "warn" | "sandwich" | "timeout" | "auto";

let _current: JevResponseType = "auto";

/**
 * Override the JEV response type for the next request(s).
 * Call in beforeEach or inside individual tests.
 */
export function setJevResponse(type: JevResponseType): void {
  _current = type;
}

/** Reset to auto-detection (inspects calldata). */
export function resetJevResponse(): void {
  _current = "auto";
}

export const jevHandler = http.post(
  "https://api.typesafe.ai/v1/decide",
  async ({ request }) => {
    const body = await request.json() as { input?: string };

    let type = _current;

    // Auto-detect from calldata in the input string
    if (type === "auto") {
      const input = body?.input ?? "";
      const isMalicious =
        input.includes("0x095ea7b3") ||
        input.includes("ApprovalSpenders:") ||
        input.includes(MALICIOUS_CALLDATA.toLowerCase()) ||
        input.includes("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      type = isMalicious ? "malicious" : "benign";
    }

    if (type === "timeout") {
      // Delay longer than ANALYSIS_TIMEOUT_MS (800ms) to trigger AbortError → heuristicFallback
      await delay(1400);
      return HttpResponse.json(BENIGN_JEV_RESPONSE);
    }

    const responseMap = {
      benign:    BENIGN_JEV_RESPONSE,
      malicious: MALICIOUS_JEV_RESPONSE,
      warn:      WARN_JEV_RESPONSE,
      sandwich:  SANDWICH_JEV_RESPONSE,
    } as const;

    return HttpResponse.json(responseMap[type as keyof typeof responseMap] ?? BENIGN_JEV_RESPONSE);
  }
);
