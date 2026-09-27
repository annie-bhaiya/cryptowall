/**
 * tests/jest.setup.ts — Global test environment setup
 *
 * Loaded via jest.config.js `setupFiles` before every test file.
 * - Sets required env vars so JevClient / proxy harness don't fail validation
 * - Configures global test timeout
 */

// Required by src/jevClient.ts (and proxy harness validation)
process.env["JEV_API_KEY"]            = "test-api-key-for-jest";
process.env["JEV_ENDPOINT"]           = "https://api.typesafe.ai/v1/decide";
process.env["UPSTREAM_RPC"]           = "http://127.0.0.1:8546";
process.env["POLICY_MODE"]            = "strict";
process.env["ANALYSIS_TIMEOUT_MS"]    = "800";
process.env["MAX_CONCURRENT_ANALYSES"] = "50";
process.env["NODE_ENV"]               = "test";
