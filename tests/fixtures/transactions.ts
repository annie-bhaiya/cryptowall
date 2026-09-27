/**
 * tests/fixtures/transactions.ts
 *
 * Signed raw transaction fixtures for CircuitBreaker-AI integration tests.
 *
 * Generated with scripts/gen-fixtures.mjs using Anvil's default test account:
 *   address:    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *   private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *
 * Chain: 31337 (Anvil local) — these transactions will not replay on mainnet.
 */

import type { TransactionPayload, UserOperation } from "../../src/types.js";

// ─── Addresses ────────────────────────────────────────────────────────────────

/** Anvil test account 0 — sender */
export const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** Fake USDC token contract address */
export const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Safe recipient (Anvil account 1) */
export const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Malicious drainer address */
export const DRAINER = "0xDeaDBeef00000000000000000000000000000000";

// ─── ERC-20 Calldata ──────────────────────────────────────────────────────────

/**
 * transfer(0x7099...79C8, 1_000_000)
 * Selector 0xa9059cbb — benign ERC-20 transfer
 */
export const BENIGN_CALLDATA =
  "0xa9059cbb" +
  "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8" +
  "00000000000000000000000000000000000000000000000000000000000f4240";

/**
 * approve(0xDeaDBeef..., MAX_UINT256)
 * Selector 0x095ea7b3 — phishing drainer pattern, detected by heuristicFallback()
 */
export const MALICIOUS_CALLDATA =
  "0x095ea7b3" +
  "000000000000000000000000deadbeef00000000000000000000000000000000" +
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ─── Signed Raw Transactions (EIP-1559, chainId 31337) ────────────────────────

/**
 * Signed ERC-20 transfer — benign, should pass through the proxy.
 * nonce: 0
 */
export const BENIGN_RAW_TX =
  "0x02f8b1827a6980843b9aca00843b9aca0082fde894a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4880b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000f4240c001a0e12d7c17f6aa00686b751b29ffa0a2695d6da458f2a9469e177b18a65073c8e1a02be727bb6ad7f2d633d57af123ee9f0b01d01c5b5d1df6cad35374fdb0f4787e";

/**
 * Signed ERC-20 MAX_UINT256 approve — malicious drainer, should be blocked.
 * nonce: 1
 */
export const MALICIOUS_RAW_TX =
  "0x02f8b1827a6901843b9aca00843b9aca0082c35094a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4880b844095ea7b3000000000000000000000000deadbeef00000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc001a07335fd02f31b254775073776e23cb9d5e417c1a3641f712c72bd31c863b99407a02e0164470a12c5e48d440deb29214cbb220d1fcf44ac63e06f5488555148f036";

// ─── Decoded TransactionPayload ───────────────────────────────────────────────

export const BENIGN_TX_PAYLOAD: TransactionPayload = {
  from:    SENDER,
  to:      TOKEN,
  data:    BENIGN_CALLDATA,
  value:   "0",
  gas:     "65000",
  nonce:   0,
  chainId: 31337,
};

export const MALICIOUS_TX_PAYLOAD: TransactionPayload = {
  from:    SENDER,
  to:      TOKEN,
  data:    MALICIOUS_CALLDATA,
  value:   "0",
  gas:     "50000",
  nonce:   1,
  chainId: 31337,
};

// ─── ERC-4337 UserOperations ──────────────────────────────────────────────────

/**
 * Safe UserOperation — execute(TOKEN, 0, BENIGN_CALLDATA)
 * Selector 0xb61d27f6
 */
const SAFE_UO_CALLDATA =
  "0xb61d27f6" +
  "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" + // to = TOKEN
  "0000000000000000000000000000000000000000000000000000000000000000" + // value = 0
  "0000000000000000000000000000000000000000000000000000000000000060" + // data offset
  "0000000000000000000000000000000000000000000000000000000000000044" + // data length = 68
  "a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d" +
  "17dc79c800000000000000000000000000000000000000000000000000000000" +
  "000f424000000000000000000000000000000000000000000000000000000000";

/**
 * Malicious UserOperation — execute(TOKEN, 0, MALICIOUS_CALLDATA)
 */
const MALICIOUS_UO_CALLDATA =
  "0xb61d27f6" +
  "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" + // to = TOKEN
  "0000000000000000000000000000000000000000000000000000000000000000" + // value = 0
  "0000000000000000000000000000000000000000000000000000000000000060" + // data offset
  "0000000000000000000000000000000000000000000000000000000000000044" + // data length = 68
  "095ea7b3000000000000000000000000deadbeef000000000000000000000000" +
  "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff" +
  "ffffffff00000000000000000000000000000000000000000000000000000000";

export const BENIGN_USER_OP: UserOperation = {
  sender:               SENDER,
  nonce:                "0x0",
  initCode:             "0x",
  callData:             SAFE_UO_CALLDATA,
  callGasLimit:         "0x10000",
  verificationGasLimit: "0x10000",
  preVerificationGas:   "0x5000",
  maxFeePerGas:         "0x3b9aca00",
  maxPriorityFeePerGas: "0x3b9aca00",
  paymasterAndData:     "0x",
  signature:            "0x",
};

export const MALICIOUS_USER_OP: UserOperation = {
  sender:               SENDER,
  nonce:                "0x1",
  initCode:             "0x",
  callData:             MALICIOUS_UO_CALLDATA,
  callGasLimit:         "0x10000",
  verificationGasLimit: "0x10000",
  preVerificationGas:   "0x5000",
  maxFeePerGas:         "0x3b9aca00",
  maxPriorityFeePerGas: "0x3b9aca00",
  paymasterAndData:     "0x",
  signature:            "0x",
};

// ─── JSON-RPC Request Factory ─────────────────────────────────────────────────

let _idCounter = 1;

export function makeRpcRequest(
  method: string,
  params: unknown[],
  id?: number
): { jsonrpc: "2.0"; id: number; method: string; params: unknown[] } {
  return { jsonrpc: "2.0", id: id ?? _idCounter++, method, params };
}

export const FAKE_TX_HASH =
  "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
