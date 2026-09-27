import { serializeTransaction, keccak256 } from "viem";
import { sign } from "viem/accounts";

const PRIVKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ── Benign: ERC-20 transfer(0x7099...79C8, 1_000_000) ────────────────────────
const benignTx = {
  chainId: 31337,
  nonce: 0,
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 1000000000n,
  gas: 65000n,
  to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  value: 0n,
  data: "0xa9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000f4240",
  type: "eip1559",
};
const benignUnsigned = serializeTransaction(benignTx);
const benignHash = keccak256(benignUnsigned);
const benignSig = await sign({ hash: benignHash, privateKey: PRIVKEY });
const benignRaw = serializeTransaction(benignTx, benignSig);

// ── Malicious: ERC-20 approve(0xDeaDBeef..., MAX_UINT256) ─────────────────────
const maliciousTx = {
  chainId: 31337,
  nonce: 1,
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 1000000000n,
  gas: 50000n,
  to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  value: 0n,
  data: "0x095ea7b3000000000000000000000000deadbeef00000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  type: "eip1559",
};
const maliciousUnsigned = serializeTransaction(maliciousTx);
const maliciousHash = keccak256(maliciousUnsigned);
const maliciousSig = await sign({ hash: maliciousHash, privateKey: PRIVKEY });
const maliciousRaw = serializeTransaction(maliciousTx, maliciousSig);

console.log("BENIGN=" + benignRaw);
console.log("MALICIOUS=" + maliciousRaw);
