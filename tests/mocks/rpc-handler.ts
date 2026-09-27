/**
 * tests/mocks/rpc-handler.ts
 *
 * MSW handler for the upstream Ethereum RPC endpoint.
 * Intercepts ALL POST requests to any URL that looks like an RPC (any origin).
 * When ANVIL=1 is set this handler is NOT registered — real Anvil is used instead.
 *
 * Handles:
 *   - debug_traceCall   → empty call trace
 *   - eth_call          → 0x (success)
 *   - eth_sendRawTransaction   → fake tx hash
 *   - eth_sendUserOperation    → fake userOp hash
 *   - eth_blockNumber   → 0x1234
 *   - everything else   → generic success
 */

import { http, HttpResponse } from "msw";
import {
  DEBUG_TRACE_NOT_SUPPORTED,
  DEBUG_TRACE_CALL_EMPTY,
  ETH_CALL_SUCCESS,
  SEND_RAW_TX_SUCCESS,
  SEND_USER_OP_SUCCESS,
  ETH_BLOCK_NUMBER,
} from "../fixtures/rpc-responses.js";

// Intercept any HTTP POST that contains a JSON-RPC method field
// We match on all origins since the proxy's UPSTREAM_RPC can be any URL
export const rpcHandler = http.post(
  // Matches http://127.0.0.1:8546 (Anvil) and any mock RPC URLs
  /http:\/\/(127\.0\.0\.1|localhost):8546/,
  async ({ request }) => {
    const body = await request.json() as
      | { method: string; id: number | string; params?: unknown[] }
      | Array<{ method: string; id: number | string; params?: unknown[] }>;

    // Batch JSON-RPC
    if (Array.isArray(body)) {
      const responses = body.map(req => dispatch(req));
      return HttpResponse.json(responses);
    }

    return HttpResponse.json(dispatch(body));
  }
);

function dispatch(req: { method: string; id: number | string }): object {
  const id = req.id;

  switch (req.method) {
    case "debug_traceCall":
      // Return a successful empty trace
      return { ...DEBUG_TRACE_CALL_EMPTY, id };

    case "eth_call":
      return { ...ETH_CALL_SUCCESS, id };

    case "eth_sendRawTransaction":
      return { ...SEND_RAW_TX_SUCCESS, id };

    case "eth_sendUserOperation":
      return { ...SEND_USER_OP_SUCCESS, id };

    case "eth_blockNumber":
      return { ...ETH_BLOCK_NUMBER, id };

    default:
      // Generic pass-through for anything else (eth_chainId, eth_getBalance, etc.)
      return { jsonrpc: "2.0", id, result: "0x1" };
  }
}

/**
 * Variant that forces debug_traceCall to return "method not found",
 * triggering eth_call fallback in SimulationEngine.
 */
export const rpcHandlerNoTrace = http.post(
  /http:\/\/(127\.0\.0\.1|localhost):8546/,
  async ({ request }) => {
    const body = await request.json() as { method: string; id: number | string };

    if (body.method === "debug_traceCall") {
      return HttpResponse.json({ ...DEBUG_TRACE_NOT_SUPPORTED, id: body.id });
    }

    return HttpResponse.json(dispatch(body));
  }
);
