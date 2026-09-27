# Integration Test Suite Plan — CryptoWall

## Top-Level Overview

Build a complete Jest + Anvil integration test suite for the CryptoWall proxy.
The suite spins up a local Anvil fork (or falls back to a mock RPC) as the upstream, starts the Fastify proxy server in-process, mocks the JEV AI endpoint with `msw` (Mock Service Worker), then fires real JSON-RPC requests at the proxy to exercise the full pipeline end-to-end.

**Anvil mode:** `ANVIL=1` env flag swaps the mock RPC handler for a real Anvil process on `http://127.0.0.1:8546`. Default is fully offline MSW mocks.

**Scope:**
- Jest configuration compatible with ES modules (`"type": "module"`, `nodenext` module resolution)
- Mock transaction fixtures: one benign ERC-20 transfer, one malicious MAX_UINT256 approval (phishing drainer)
- Proxy integration tests covering: health endpoint, policy endpoint, benign tx pass-through, malicious tx block, audit mode pass-through, UserOperation intercept, batch RPC
- Policy unit tests for strict/permissive/audit thresholds
- JevClient unit tests: evaluate() with mocked API, heuristicFallback() logic
- SimulationEngine unit tests: eth_call fallback parsing, state change extraction

**Non-goals:**
- Testing viem WalletClient / PublicClient wrapper (SDK layer) — these are thin wrappers around viem
- Performance or load testing
- Real JEV API calls (all mocked offline)
- Real mainnet state (Anvil used in blank/empty mode, not a fork)

---

## Sub-Tasks

---

### Sub-Task 1 — Jest + ESM Configuration

**Intent:**  
The project uses `"type": "module"` and `module: "nodenext"` in tsconfig. Standard Jest does not support ESM natively; we must configure it via `--experimental-vm-modules` (already in the `test` script) and use `ts-jest` in ESM mode, or use `@jest/globals` with native ESM transforms. The cleanest option for `nodenext` is `ts-jest` with `extensionsToTreatAsEsm` + `useESM: true`.

**Expected Outcomes:**
- `jest.config.js` (ESM) present at root
- `jest.setup.ts` present with global test env setup
- `package.json` devDependencies includes `jest`, `@types/jest`, `ts-jest`, `msw`
- `npm test` runs without module resolution errors on an empty test file

**Todo List:**
1. Add devDependencies to `package.json`: `jest`, `@types/jest`, `ts-jest`, `msw`, `@types/msw`
2. Create `jest.config.js` with:
   - `preset: "ts-jest/presets/default-esm"`
   - `extensionsToTreatAsEsm: [".ts"]`
   - `testEnvironment: "node"`
   - `testMatch: ["**/tests/**/*.test.ts"]`
   - `moduleNameMapper` for `.js` → `.ts` ESM path rewriting
   - `setupFilesAfterEach: ["./tests/jest.setup.ts"]`
   - `globals: { ts-jest: { useESM: true, tsconfig: { module: "esnext", moduleResolution: "bundler" } } }`
3. Create `tests/` directory and `tests/jest.setup.ts` (sets timeout, env vars, dotenv load)
4. Create `tests/fixtures/` directory

**Relevant Context:**
- `package.json` `"type": "module"`, test script: `node --experimental-vm-modules node_modules/.bin/jest`
- `tsconfig.json`: `module: nodenext`, `moduleResolution: nodenext` — ts-jest needs override to `esnext`/`bundler` for test compilation
- No jest config or test dir exists yet

**Status:** `[ ] pending`

---

### Sub-Task 2 — Transaction Fixtures

**Intent:**  
Generate the two required signed raw transaction hex strings that the proxy's `eth_sendRawTransaction` handler will receive. These must be real RLP-encoded transactions that viem's `parseTransaction()` can decode without error. A sub-agent will generate these using viem's `serializeTransaction` + a test private key against Anvil's default chain (chainId 31337).

**Expected Outcomes:**
- `tests/fixtures/transactions.ts` exports:
  - `BENIGN_RAW_TX`: signed ERC-20 `transfer(recipient, 1000)` on USDC-like token
  - `MALICIOUS_RAW_TX`: signed ERC-20 `approve(drainer, MAX_UINT256)` phishing drainer
  - `BENIGN_TX_PAYLOAD`: decoded `TransactionPayload` for unit tests
  - `MALICIOUS_TX_PAYLOAD`: decoded `TransactionPayload` for unit tests
  - `BENIGN_USER_OP`: an ERC-4337 UserOperation with safe callData
  - `MALICIOUS_USER_OP`: an ERC-4337 UserOperation with drainer callData
  - helper `makeRpcRequest(method, params)` factory

**Todo List:**
1. Spawn sub-agent to generate `BENIGN_RAW_TX` using viem `serializeTransaction` (chainId=31337, nonce=0, gasPrice=1gwei, gas=21000, to=fake token, data=transfer selector + ABI-encoded args, signed with Anvil test private key `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`)
2. Spawn sub-agent to generate `MALICIOUS_RAW_TX` similarly with `approve` selector + `ffffffff...ff` amount
3. Write `tests/fixtures/transactions.ts` with all exports
4. Write `tests/fixtures/jev-responses.ts` exporting mock JEV API responses:
   - `BENIGN_JEV_RESPONSE`: `risk_category: "normal"`, `exploit_probability: 0.05`, `severity_score: 1`
   - `MALICIOUS_JEV_RESPONSE`: `risk_category: "malicious_approval"`, `exploit_probability: 0.94`, `severity_score: 4`
5. Write `tests/fixtures/rpc-responses.ts` exporting mock upstream RPC responses (eth_call, debug_traceCall, eth_sendRawTransaction success)

**Relevant Context:**
- Benign calldata: selector `0xa9059cbb` (transfer) + 32-byte padded recipient + 32-byte padded amount
- Malicious calldata: selector `0x095ea7b3` (approve) + 32-byte padded spender + `ff*32` (MAX_UINT256)
- viem's `parseTransaction()` in `src/server.ts` casts result as `Record<string, unknown>` — `from` not present on type (raw tx has no `from`; it must come from ECDSA recovery via viem's `recoverTransactionAddress`)
- Anvil test account: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` / privkey `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

**Status:** `[ ] pending`

---

### Sub-Task 3 — MSW Mock Server Setup

**Intent:**  
The JEV AI endpoint and upstream RPC are external HTTP services. In tests we intercept them with `msw` (Mock Service Worker in Node mode) so tests run fully offline with deterministic responses. The mock can be toggled per-test to simulate API timeouts, partial failures, and heuristic fallback paths.

**Expected Outcomes:**
- `tests/mocks/jev-handler.ts`: MSW handler that intercepts `POST https://api.typesafe.ai/v1/decide` and returns either the benign or malicious JEV response based on the calldata in the request body
- `tests/mocks/rpc-handler.ts`: MSW handler that intercepts `POST` to any RPC URL and returns canned `debug_traceCall` + `eth_sendRawTransaction` responses
- `tests/mocks/server.ts`: creates and exports the MSW Node server (`setupServer(...handlers)`)
- `tests/jest.setup.ts` starts/stops the MSW server around each test suite

**Todo List:**
1. Create `tests/mocks/jev-handler.ts` — inspect `body.input` to decide benign vs malicious response
2. Create `tests/mocks/rpc-handler.ts` — handle `debug_traceCall` (return empty trace), `eth_call` (return `0x`), `eth_sendRawTransaction` (return a fake tx hash `0xabc...`)
3. Create `tests/mocks/server.ts` — `setupServer(jevHandler, rpcHandler)`
4. Update `tests/jest.setup.ts` to call `mockServer.listen({ onUnhandledRequest: "warn" })` before tests and `mockServer.close()` after
5. Export `setJevResponse(type: "benign" | "malicious" | "timeout")` helper for per-test overrides

**Relevant Context:**
- JEV endpoint: `https://api.typesafe.ai/v1/decide` (from `src/jevClient.ts` DEFAULT_JEV_ENDPOINT)
- On timeout (AbortError), `jevClient` falls through to `heuristicFallback()` — test this path by making MSW handler delay > `ANALYSIS_TIMEOUT_MS`
- Upstream RPC: set to `http://127.0.0.1:8545` in test env (Anvil) — MSW intercepts this too so Anvil is not required to run

**Status:** `[ ] pending`

---

### Sub-Task 4 — Proxy Server Test Harness

**Intent:**  
The integration tests need to start and stop the Fastify proxy server in-process (not as a subprocess) so tests have full control over the server lifecycle and can inspect internal state. We export a `startTestProxy(overrides?)` helper that creates the proxy with test-specific env overrides and returns the server URL.

**Expected Outcomes:**
- `tests/helpers/proxy.ts` exports:
  - `startTestProxy(env?: Partial<Record<string, string>>): Promise<{ url: string; close: () => Promise<void> }>`
  - Starts proxy on a random available port (not 8545 to avoid clash with Anvil)
  - Sets `UPSTREAM_RPC=http://127.0.0.1:8546` (Anvil) or mock RPC URL
  - Sets `JEV_API_KEY=test-key`
  - Sets `POLICY_MODE=strict` by default
  - Returns `url` to call against and `close()` to tear down
- `tests/helpers/rpc.ts` exports:
  - `sendRpc(url, method, params)`: typed JSON-RPC fetch helper
  - `sendRawTx(url, rawHex)`: wraps `eth_sendRawTransaction`

**Todo List:**
1. Create `tests/helpers/proxy.ts` — import Fastify + all proxy components, instantiate them directly (not via `src/server.ts` which has side effects), return started server
2. Create `tests/helpers/rpc.ts` — fetch-based JSON-RPC client for tests
3. Ensure `JEV_API_KEY` is set in test env (via `tests/jest.setup.ts` or `process.env`)
4. Handle port conflict: use `listen({ port: 0 })` to get OS-assigned port, then read `fastify.server.address()`

**Relevant Context:**
- `src/server.ts` has module-level side effects (dotenv, undici, semaphore, server start) — tests must NOT import it directly
- Instead, `tests/helpers/proxy.ts` assembles the same pipeline (JevClient + SimulationEngine + PolicyEngine + Fastify routes) independently, mimicking `src/server.ts` but without the `fastify.listen()` at import time
- `fastify.inject()` can also be used for in-process testing without a real TCP port — use this for unit-style route tests

**Status:** `[ ] pending`

---

### Sub-Task 5 — Integration Tests: Proxy Routes

**Intent:**  
End-to-end tests that fire real HTTP requests at the running proxy and assert on JSON-RPC responses. Covers the full pipeline: request parsing → simulation → JEV eval → policy gate → block/warn/allow → upstream forward.

**Expected Outcomes:**
- `tests/integration/proxy.test.ts` with test groups:
  1. **Health & info routes** — `GET /health` returns `{ status: "ok" }`, `GET /policy` returns thresholds
  2. **Benign ERC-20 transfer** — `eth_sendRawTransaction` with `BENIGN_RAW_TX` passes through (JEV mock returns `normal`/0.05), response has `result` (tx hash from mock RPC)
  3. **Malicious approval (strict mode)** — `eth_sendRawTransaction` with `MALICIOUS_RAW_TX` is blocked; response `error.code === -32003`; `error.data.decision.risk_category === "malicious_approval"`; `error.data.decision.exploit_probability >= 0.7`
  4. **Audit mode pass-through** — same malicious tx with `POLICY_MODE=audit` is NOT blocked; response has `result`
  5. **Permissive mode** — malicious tx at 0.72 probability NOT blocked (permissive threshold is 0.92); response has `result`
  6. **Heuristic fallback path** — JEV API timeout → heuristicFallback detects MAX_UINT256 → blocks in strict mode
  7. **Heuristic fallback** (separate named test: "blocks malicious approval via heuristic fallback when JEV API times out") — JEV API MSW handler delays 1200ms (> 800ms timeout) → AbortError → `heuristicFallback()` detects MAX_UINT256 → blocks in strict mode
  8. **Batch RPC** — array of two requests, benign passes, malicious blocked in same batch response
  9. **Non-send pass-through** — `eth_blockNumber` passes through immediately with no analysis overhead
  10. **UserOperation intercept** — `eth_sendUserOperation` with malicious callData is blocked

**Todo List:**
1. Write `tests/integration/proxy.test.ts`
2. Use `beforeAll` to call `startTestProxy()` and start MSW mock server
3. Use `afterAll` to close proxy and MSW
4. For each test: set the JEV mock response type via `setJevResponse()`, send request via `sendRpc()`, assert response shape
5. Assert on `error.code`, `error.data.decision.*`, `result` presence
6. Timeout tests: set MSW to delay 1200ms (> 800ms timeout), assert heuristic fallback kicks in

**Relevant Context:**
- Strict policy thresholds: `exploitProbabilityThreshold: 0.70`, `minSeverityToBlock: 4`, `alwaysBlockCategories: ["malicious_approval", "poison_token", "reentrancy_risk"]`
- `malicious_approval` is in `alwaysBlockCategories` for strict mode — it's blocked regardless of probability
- Audit mode never blocks (threshold = Infinity, all categories in `neverBlockCategories`)
- Permissive threshold is 0.92 — a 0.72 probability approval passes through
- Blocked response shape: `{ jsonrpc: "2.0", id, error: { code: -32003, message: "...", data: { reqId, decision: {...} } } }`

**Status:** `[ ] pending`

---

### Sub-Task 6 — Unit Tests: JevClient + PolicyEngine + SimulationEngine

**Intent:**  
Unit tests that directly instantiate the internal classes and test their logic in isolation, without the Fastify server. Covers the heuristic fallback logic, policy threshold matrix, and simulation state-change extraction.

**Expected Outcomes:**
- `tests/unit/jevClient.test.ts`:
  - `evaluate()` with mocked fetch returning well-formed JEV response → correct DecisionMatrix
  - `heuristicFallback()` with MAX_UINT256 approval → `malicious_approval`, probability 0.72, severity 4
  - `heuristicFallback()` with normal transfer → `normal`, probability 0.1
  - `heuristicFallback()` with reverted simulation → probability 0.55, severity 3
  - `evaluate()` with MSW timeout → falls back to `heuristicFallback()`
- `tests/unit/policy.test.ts`:
  - Strict mode: `exploit_probability=0.94` → `block`
  - Strict mode: `risk_category=malicious_approval` → always block
  - Strict mode: `exploit_probability=0.50`, `risk_category=normal` → `allow`
  - Strict mode: `exploit_probability=0.50`, `risk_category=unverified_calldata` → `warn`
  - Permissive mode: `exploit_probability=0.72` → `allow` (below 0.92 threshold)
  - Permissive mode: `risk_category=poison_token` → block (always-block in permissive)
  - Audit mode: any input → always `allow` or `warn`, never `block`
  - Custom threshold override: `exploitProbabilityThreshold: 0.40` → blocks at 0.50
- `tests/unit/simulation.test.ts`:
  - `extractStateChangesFromCalldata()` with transfer calldata → correct `erc20_transfer` state change
  - `extractStateChangesFromCalldata()` with approve MAX_UINT256 → `erc20_approval` with correct spender
  - `decodeRevertReason()` with ABI-encoded `Error("insufficient balance")` → correct string
  - `SimulationEngine.simulate()` with MSW mock returning `debug_traceCall` trace → correct SimulationTrace
  - `SimulationEngine.simulate()` where `debug_traceCall` fails → falls back to `eth_call`

**Todo List:**
1. Export `extractStateChangesFromCalldata` and `decodeRevertReason` from `src/simulation.ts` (make them named exports)
2. Write `tests/unit/jevClient.test.ts`
3. Write `tests/unit/policy.test.ts`
4. Write `tests/unit/simulation.test.ts` — call exported helpers directly for unit tests; also test via `simulate()` with MSW mocks for integration coverage

**Relevant Context:**
- `src/jevClient.ts` `heuristicFallback()`: MAX_UINT256 check uses `tx.data.startsWith("0x095ea7b3")` AND `tx.data.endsWith("fff...fff")`
- `src/policy.ts` STRICT_DEFAULTS: `alwaysBlockCategories: ["malicious_approval", "poison_token", "reentrancy_risk"]`
- `src/simulation.ts`: `extractStateChangesFromCalldata` and `decodeRevertReason` will be exported — also tested via `simulate()` with MSW mocks
- `decodeRevertReason()` is also private — test via `simulate()` with MSW mock that returns an `error.data` field with ABI-encoded revert

**Status:** `[ ] pending`

---

## Test Directory Structure

```
tests/
├── jest.setup.ts              # Global setup: MSW server lifecycle, env vars
├── fixtures/
│   ├── transactions.ts        # Raw tx hex + payload constants
│   ├── jev-responses.ts       # Canned JEV API response bodies
│   └── rpc-responses.ts       # Canned upstream RPC response bodies
├── mocks/
│   ├── jev-handler.ts         # MSW handler for JEV AI endpoint
│   ├── rpc-handler.ts         # MSW handler for upstream Ethereum RPC
│   └── server.ts              # setupServer() export
├── helpers/
│   ├── proxy.ts               # startTestProxy() — in-process Fastify harness
│   └── rpc.ts                 # sendRpc() / sendRawTx() fetch helpers
├── integration/
│   └── proxy.test.ts          # End-to-end proxy tests
└── unit/
    ├── jevClient.test.ts
    ├── policy.test.ts
    └── simulation.test.ts
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **In-process Fastify** via `fastify.inject()` for unit-style tests, real TCP for integration tests | `inject()` is faster and avoids port conflicts; real TCP tests the full HTTP stack including content parsing |
| **MSW for both JEV and upstream RPC** | Tests run fully offline; deterministic responses; easy per-test override for timeout/error paths |
| **Do NOT import `src/server.ts`** | It has module-level side effects (undici dispatcher, semaphore, `fastify.listen()`) — tests instantiate components directly |
| **ts-jest with `useESM: true`** | The project's `"type": "module"` + `nodenext` tsconfig requires ESM-native Jest transforms |
| **Anvil optional** | Integration tests target a mock RPC handler (MSW), so Anvil is not a hard dependency — but the tests are written so they work with a real Anvil on port 8546 if available |
| **Fixtures as typed constants** | Raw tx hex is generated once and committed; no runtime keygen needed in test runs |

---

## Context for Implementation

- **JEV mock logic:** Inspect `body.input` (the context string) for `"ApprovalSpenders:"` or calldata starting with `0x095ea7b3...fff` to route to malicious vs benign response
- **Blocked response discriminant:** `response.error?.code === -32003`
- **Warn response:** `response.result !== undefined && (response as any).warning !== undefined`
- **Strict alwaysBlock:** `malicious_approval` is always blocked — the probability check doesn't even run
- **Heuristic path trigger:** Set MSW JEV handler to respond after 1200ms (> 800ms `ANALYSIS_TIMEOUT_MS`) → AbortError → `heuristicFallback()`
- **Raw tx generation:** Use viem `serializeTransaction` + `sign` with Anvil's test private key (`0xac0974...ff80`) and chainId=31337
