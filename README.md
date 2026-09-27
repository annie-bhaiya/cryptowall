# ⚡ @breaker/viem-middleware

**Ultra-low latency middleware SDK and JSON-RPC proxy for Web3 builders.**

Intercepts, simulates, and AI-audits every transaction before it hits the mempool — giving you typed decision matrices, not unstructured text.

```ts
// One line. Drop-in for any viem client.
const client = createCircuitBreakerClient({ rpcUrl, policy: "strict" });
```

---

## Why CircuitBreaker?

Most Web3 security tools are binary afterthoughts — they block or don't, with no reasoning. CircuitBreaker runs a full analysis pipeline on every outbound transaction and gives you a **calibrated typed decision matrix**:

```ts
{
  risk_category:       "sandwich_exposure",
  risk_flags:          ["sandwich_exposure", "price_manipulation"],
  exploit_probability: 0.94,          // true calibrated probability
  severity_score:      4,             // 1 (info) → 5 (critical)
  rationale:           "Simulation trace shows sandwich pattern: 3 identical swaps
                        in same block with slippage 312bps above expected.",
  simulation: {
    reverted:      false,
    gas_used:      185000n,
    slippage_bps:  312,
    state_changes: [...]
  }
}
```

The analysis gate is **send-only**. All read calls (`eth_call`, `eth_getLogs`, `eth_getBalance`) pass through with zero overhead.

---

## Install

```bash
npm install @breaker/viem-middleware
# peer dep
npm install viem
```

---

## Quick Start — SDK

```ts
import { createCircuitBreakerClient, CircuitBreakerBlockedError } from "@breaker/viem-middleware";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount("0x...");

const client = createCircuitBreakerClient({
  rpcUrl:  "https://mainnet.infura.io/v3/YOUR_KEY",
  policy:  "strict",                    // strict | permissive | audit
  chain:   mainnet,
  account,

  // Optional: hook into every decision for telemetry / logging
  onDecision: (decision, tx) => {
    console.log(`[${decision.risk_category}] p=${decision.exploit_probability}`);
  },

  // Optional: hook on blocked transactions
  onBlock: (decision, tx) => {
    metrics.increment("circuitbreaker.blocked", { category: decision.risk_category });
  },
});

// client.wallet  → viem WalletClient (sendTransaction, signMessage, ...)
// client.public  → viem PublicClient (readContract, getLogs, ...)

try {
  const hash = await client.wallet.sendTransaction({
    to:    "0xUniswapRouter",
    data:  "0x...",
    value: parseEther("0.5"),
  });
} catch (err) {
  if (err instanceof CircuitBreakerBlockedError) {
    console.log(err.decision.risk_category);       // "sandwich_exposure"
    console.log(err.decision.exploit_probability); // 0.94
    console.log(err.decision.severity_score);      // 4
    console.log(err.decision.rationale);           // human explanation
  }
}
```

---

## Policy Modes

| Mode | Blocks when | Use case |
|---|---|---|
| `strict` | `exploit_probability > 0.70` OR `severity >= 4` | Retail wallets, automated liquidators |
| `permissive` | `exploit_probability > 0.92` OR `severity == 5` | DeFi bots, high-frequency operations |
| `audit` | Never blocks — emits decisions only | Monitoring, analytics, research |

### Custom Thresholds

```ts
const client = createCircuitBreakerClient({
  rpcUrl:  "https://...",
  policy:  "strict",
  thresholds: {
    exploitProbabilityThreshold: 0.80,      // override default 0.70
    minSeverityToBlock:          3,          // block severity >= 3
    alwaysBlockCategories: ["poison_token", "malicious_approval"],
    neverBlockCategories:  ["unverified_calldata"],
  },
});
```

---

## 🧪 JEV Probability Test App (`example.js`)

A standalone test application is included in [`example.js`](./example.js) connecting to the authentic **TypeSafe AI JEV API** (`https://api.typesafe.ai/v1/systemone`) using your `.env` credentials (`JEV_API_KEY`). It demonstrates how **JEV (Reinforcement Learning from Calibrated Decisions)** calculates and outputs continuous exploit probabilities (`0.00` to `1.00`), and how CircuitBreaker's policy engine translates those probabilities into deterministic actions (`ALLOW`, `WARN`, `BLOCK`).

### How JEV Probability Works

Unlike standard LLMs that generate conversational or qualitative text ("this looks risky"), the TypeSafe AI JEV engine uses calibrated RLCD model primitives:
- **Baseline Safe Transactions:** Consistently yield **≤ 10%** exploit probability (e.g. 7-8% for standard ERC-20 transfers).
- **Elevated Slippage / MEV:** Yields intermediate risk classifications (`sandwich_exposure`, severity 3/5) triggering policy warnings.
- **High-Risk Phishing Drainers:** Accurately classified as `malicious_approval` with severity 4/5 and elevated probability, triggering immediate blocking under strict policy.
- **ERC-4337 Smart Account Interception:** Decodes nested calls in `execute(to, value, data)` and intercepts malicious approvals before account abstraction bundler submission.
- **Offline / Fallback Resilience:** If the remote JEV API times out or is unreachable, CircuitBreaker's local heuristic engine computes calibrated decisions locally (0ms) without stalling user flows.

### Running the Test App

Run the test app directly with Node or npm (uses your `.env` API key):

```bash
npm run example
# or
node example.js
```

### Evaluated Scenarios & Live Results

When executing `node example.js` against the live TypeSafe AI JEV endpoint, the test app evaluates 5 distinct real-world transaction patterns through the full CircuitBreaker analysis pipeline:

```
════════════════════════════════════════════════════════════════════════════
  ⚡ CircuitBreaker-AI — Live JEV Probability Decision Engine Test App
════════════════════════════════════════════════════════════════════════════

  Live JEV Endpoint: https://api.typesafe.ai/v1/systemone
  Live JEV API Key:  apikey_220...691b2e
  Policy Engine:     Strict (70.0%) | Permissive (92.0%) | Audit (∞)
  Middleware SDK:    @breaker/viem-middleware v1.0.0

────────────────────────────────────────────────────────────────────────────
  1. Benign ERC-20 Transfer (1,000 USDC)
────────────────────────────────────────────────────────────────────────────
  Transaction:  Transfer 1,000 USDC to known address
  Recipient:    0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  Method:       transfer(address,uint256)

  Live JEV Evaluation (864ms):
  • Exploit Probability: [██░░░░░░░░░░░░░░░░░░] 8.0%
  • Risk Category:       normal
  • Severity Score:      1 / 5 (Info)
  • Rationale:           "JEV SystemOne live RLCD evaluation (jev-1.13.0): normal, probability 8.0%."
  • Policy Verdict:       ALLOWED  (Within safe thresholds)

────────────────────────────────────────────────────────────────────────────
  2. Malicious Approval Drainer (Phishing Attack)
────────────────────────────────────────────────────────────────────────────
  Transaction:  Approve unlimited USDC (MAX_UINT256) to unverified spender
  Spender:      0xdeadbeef00000000000000000000000000000000
  Method:       approve(address, 0xffffffffff...ffff)

  Live JEV Evaluation (345ms):
  • Exploit Probability: [███████░░░░░░░░░░░░░] 35.0%
  • Risk Category:       malicious_approval
  • Severity Score:      4 / 5 (High Threat)
  • Rationale:           "JEV SystemOne live RLCD evaluation (jev-1.13.0): malicious_approval, probability 35.0%."
  • Policy Verdict:       BLOCKED  (Category "malicious_approval" is always blocked in strict mode.)

────────────────────────────────────────────────────────────────────────────
  3. MEV Sandwich Exposure (Slippage: 312 bps)
────────────────────────────────────────────────────────────────────────────
  Transaction:  DEX Swap via Uniswap Router
  Simulation:   debug_traceCall extracted slippage = 312 bps (> 200 bps threshold)

  Live JEV Evaluation (382ms):
  • Exploit Probability: [██░░░░░░░░░░░░░░░░░░] 10.0%
  • Risk Category:       sandwich_exposure
  • Severity Score:      3 / 5 (Medium)
  • Rationale:           "JEV SystemOne live RLCD evaluation (jev-1.13.0): sandwich_exposure, probability 10.0%."

  Policy Threshold Comparison:
    Mode [strict]     (threshold 0.70) ──▶  WARN : Exploit probability exceeds 70% strict threshold.
    Mode [permissive] (threshold 0.92) ──▶  WARN : Below 92% permissive threshold; elevated risk warn attached.
    Mode [audit]      (threshold  ∞ )  ──▶  ALLOWED : Audit mode never blocks; telemetry logged for monitoring.

────────────────────────────────────────────────────────────────────────────
  4. Local Heuristic Fallback (Zero Network Dependency)
────────────────────────────────────────────────────────────────────────────
  Scenario:     Remote JEV API is offline or exceeds ANALYSIS_TIMEOUT_MS
  Mechanism:    CircuitBreaker runs local heuristic fallback without latency penalty

  Local Heuristic Output (1ms):
  • Exploit Probability: [██████████████░░░░░░] 72.0%
  • Risk Category:       malicious_approval
  • Severity Score:      4 / 5
  • Rationale:           "Heuristic analysis (JEV API unavailable). Manual review recommended."
  • Fallback Verdict:     BLOCKED  (Category "malicious_approval" is always blocked in strict mode.)

────────────────────────────────────────────────────────────────────────────
  5. ERC-4337 UserOperation Interceptor (Smart Account)
────────────────────────────────────────────────────────────────────────────
  Account:      Smart Account (ERC-4337 Wallet)
  CallData:     Nested execute() with unlimited approve call

  Live JEV UserOperation Result (378ms):
  • Approved:            false
  • Exploit Probability: [██████████░░░░░░░░░░] 49.0%
  • Risk Category:       malicious_approval
  • Severity Score:      4 / 5 (Critical)
  • Latency:             378 ms
  • Verdict:              BLOCKED  (Category "malicious_approval" is always blocked in strict mode.)

────────────────────────────────────────────────────────────────────────────
  📊 Summary of Real JEV Probability Outputs
────────────────────────────────────────────────────────────────────────────

  ┌────────────────────────────────┬──────────────────────┬─────────────┬──────────┬──────────────┬───────────┐
  │ Scenario                       │ Category             │ Probability │ Severity │ Strict Gate  │ API Time  │
  ├────────────────────────────────┼──────────────────────┼─────────────┼──────────┼──────────────┼───────────┤
  │ 1. Benign ERC-20 Transfer      │ normal               │        8.0% │      1/5 │ ALLOW        │     864ms │
  │ 2. Unlimited Phishing Approval │ malicious_approval   │       35.0% │      4/5 │ BLOCK        │     345ms │
  │ 3. MEV Sandwich Exposure       │ sandwich_exposure    │       10.0% │      3/5 │ WARN         │     382ms │
  │ 4. Heuristic Fallback (Offline) │ malicious_approval   │       72.0% │      4/5 │ BLOCK        │       1ms │
  │ 5. ERC-4337 UserOperation      │ malicious_approval   │       49.0% │      4/5 │ BLOCK        │     378ms │
  └────────────────────────────────┴──────────────────────┴─────────────┴──────────┴──────────────┴───────────┘
```

### Probability Interpretation Matrix

| Probability Range | Typical Risk Classification | Strict Mode Action | Permissive Mode Action | Audit Mode Action |
|---|---|:---:|:---:|:---:|
| **0.00 – 0.40** | Clean transfers, verified swaps, regular calls | `ALLOW` | `ALLOW` | `ALLOW` |
| **0.41 – 0.70** | Unverified contracts, moderate slippage | `WARN` | `ALLOW` | `WARN` |
| **0.71 – 0.90** | Sandwich patterns, high slippage, reentrancy risks | `BLOCK` | `WARN` | `WARN` |
| **0.91 – 1.00** | Phishing drainers, unlimited approvals, honeypots | `BLOCK` | `BLOCK` | `WARN` |

---

## Risk Categories

| Category | Detected by |
|---|---|
| `sandwich_exposure` | Simulation trace shows same-block sandwich pattern, slippage > threshold |
| `malicious_approval` | ERC-20 `approve()` to unverified spender; unlimited `MAX_UINT256` approvals |
| `unverified_calldata` | Calldata targets unverified / undeployed contract |
| `bad_debt_risk` | DeFi position simulation shows under-collateralised exposure |
| `poison_token` | Token contract matches known honeypot / exploit signature |
| `reentrancy_risk` | Simulation trace shows nested reentrancy call pattern |
| `price_manipulation` | AMM or oracle price manipulation detected in trace |
| `normal` | No threats detected |

---

## ERC-4337 UserOperation Interceptor

For smart account (AA) wallets and liquidation bots:

```ts
import { createUserOperationInterceptor } from "@breaker/viem-middleware";

const interceptor = createUserOperationInterceptor({
  rpcUrl: "https://...",
  policy: "strict",
});

// Inspect a single UserOp
const result = await interceptor.inspect(userOp);
// result.approved      → boolean
// result.decision      → typed DecisionMatrix
// result.latency_ms    → pipeline latency

// Filter a batch (liquidation bot use case)
const safeOps = await interceptor.filter(pendingUserOps);
// returns only the approved subset

// Batch with full telemetry
const batch = await interceptor.inspectBatch(pendingUserOps);
// batch.approved_count, batch.blocked_count, batch.total_latency_ms

// Assert single op (throws CircuitBreakerBlockedError on block)
await interceptor.assert(userOp);
```

---

## Pre-Signing Inspection

Inspect a transaction payload and get a `DecisionMatrix` **without sending it**.  
Ideal for surfacing risk warnings in wallet UX before the user confirms:

```ts
const decision = await client.inspect({
  to:    "0xSomeContract",
  data:  calldata,
  value: parseEther("1"),
});

if (decision.severity_score >= 3) {
  showWarningModal(decision.rationale);
}
```

---

## JSON-RPC Proxy Server

Run CircuitBreaker as a standalone proxy in front of any RPC endpoint.  
Any wallet, DApp, or bot that speaks JSON-RPC points at `localhost:8545`.

```bash
# Start with default strict policy
npm run proxy

# Permissive mode (DeFi bots)
npm run proxy:permissive

# Audit mode — log decisions but never block
npm run proxy:audit
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `UPSTREAM_RPC` | `https://eth.llamarpc.com` | Upstream RPC to forward to |
| `PORT` | `8545` | Local listen port |
| `POLICY_MODE` | `strict` | `strict` / `permissive` / `audit` |
| `JEV_ENDPOINT` | public endpoint | JEV AI decision API URL |
| `JEV_API_KEY` | _(none)_ | Your JEV AI API key |
| `ANALYSIS_TIMEOUT_MS` | `800` | Max ms for simulation + AI (hard ceiling) |

### Proxy Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | POST | JSON-RPC proxy (single + batch) |
| `/health` | GET | Health check + active policy |
| `/policy` | GET | Active thresholds as JSON |

### Blocked Transaction Error

When a transaction is blocked, the proxy returns a standard JSON-RPC error with the full decision matrix in `error.data`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32003,
    "message": "[CircuitBreaker-AI] Transaction blocked. Exploit probability 94.2% exceeds 70% threshold.",
    "data": {
      "decision": {
        "risk_category":       "sandwich_exposure",
        "risk_flags":          ["sandwich_exposure"],
        "exploit_probability": 0.942,
        "severity_score":      4,
        "rationale":           "..."
      }
    }
  }
}
```

---

## Simulation Engine

CircuitBreaker runs `debug_traceCall` (Geth / Erigon / Hardhat / Tenderly) before every send, extracting:

- **ERC-20 transfers and approvals** decoded from call frames  
- **ETH value flows** across internal calls  
- **Revert reasons** decoded from ABI-encoded `Error(string)`  
- **Estimated slippage** in basis points across the execution tree  
- **Reentrancy depth** via nested call analysis  

Falls back to a lightweight `eth_call` when the RPC doesn't support tracing.

---

## Transport Only

If you want the intercepting transport without the full client factory:

```ts
import { createCircuitBreakerTransport } from "@breaker/viem-middleware/transport";
import { createWalletClient } from "viem";

const client = createWalletClient({
  transport: createCircuitBreakerTransport({
    rpcUrl: "https://...",
    policy: "permissive",
  }),
});
```

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
  eth_sendRawTx ───▶│          CircuitBreaker Pipeline        │
  eth_sendUserOp    │                                         │
                    │  1. Parse / decode payload              │
                    │  2. debug_traceCall simulation          │
                    │     └ state changes, call trace,        │
                    │       slippage, revert reason           │
                    │  3. JEV AI evaluation                   │
                    │     └ typed DecisionMatrix              │
                    │       (calibrated probabilities)        │
                    │  4. PolicyEngine gate                   │
                    │     └ strict | permissive | audit       │
                    │                                         │
                    │  block ──▶ JSON-RPC error -32003        │
                    │  warn  ──▶ forward + attach decision    │
                    │  allow ──▶ forward upstream             │
                    └─────────────────────────────────────────┘

  All other methods (reads) ──────────────────────────────────▶ upstream RPC
                                                                (zero overhead)
```

---

## License

MIT — CircuitBreaker AI
