/**
 * tests/fixtures/rpc-responses.ts
 *
 * Canned upstream Ethereum RPC response bodies for the MSW RPC mock handler.
 */

import { FAKE_TX_HASH } from "./transactions.js";

// ─── eth_call ─────────────────────────────────────────────────────────────────

export const ETH_CALL_SUCCESS = {
  jsonrpc: "2.0",
  id:      1,
  result:  "0x",
};

export const ETH_CALL_REVERT = {
  jsonrpc: "2.0",
  id:      1,
  error: {
    code:    3,
    message: "execution reverted",
    // ABI-encoded Error("insufficient balance")
    data: "0x08c379a0" +
          "0000000000000000000000000000000000000000000000000000000000000020" +
          "0000000000000000000000000000000000000000000000000000000000000013" +
          "696e73756666696369656e742062616c616e636500000000000000000000000000",
  },
};

// ─── debug_traceCall ──────────────────────────────────────────────────────────

export const DEBUG_TRACE_CALL_EMPTY = {
  jsonrpc: "2.0",
  id:      1,
  result: {
    type:     "CALL",
    from:     "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    to:       "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    value:    "0x0",
    gas:      "0xfde8",
    gasUsed:  "0x5208",
    input:    "0xa9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000f4240",
    output:   "0x0000000000000000000000000000000000000000000000000000000000000001",
    calls:    [],
  },
};

export const DEBUG_TRACE_CALL_WITH_APPROVAL = {
  jsonrpc: "2.0",
  id:      1,
  result: {
    type:    "CALL",
    from:    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    to:      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    value:   "0x0",
    gas:     "0xc350",
    gasUsed: "0x6978",
    input:   "0x095ea7b3000000000000000000000000deadbeef00000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    output:  "0x0000000000000000000000000000000000000000000000000000000000000001",
    calls:   [],
  },
};

export const DEBUG_TRACE_NOT_SUPPORTED = {
  jsonrpc: "2.0",
  id:      1,
  error: {
    code:    -32601,
    message: "Method not found",
  },
};

// ─── eth_sendRawTransaction ───────────────────────────────────────────────────

export const SEND_RAW_TX_SUCCESS = {
  jsonrpc: "2.0",
  id:      1,
  result:  FAKE_TX_HASH,
};

// ─── eth_blockNumber ──────────────────────────────────────────────────────────

export const ETH_BLOCK_NUMBER = {
  jsonrpc: "2.0",
  id:      1,
  result:  "0x1234",
};

// ─── eth_sendUserOperation ────────────────────────────────────────────────────

export const SEND_USER_OP_SUCCESS = {
  jsonrpc: "2.0",
  id:      1,
  result:  "0x" + "ab".repeat(32),
};
