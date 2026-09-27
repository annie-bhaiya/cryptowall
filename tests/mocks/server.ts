/**
 * tests/mocks/server.ts
 *
 * MSW Node server factory.
 *
 * Usage in test files:
 *   import { mockServer, setJevResponse } from "../mocks/server.js";
 *
 *   beforeAll(() => mockServer.listen({ onUnhandledRequest: "warn" }));
 *   afterEach(() => { mockServer.resetHandlers(); resetJevResponse(); });
 *   afterAll(() => mockServer.close());
 */

import { setupServer } from "msw/node";
import { jevHandler } from "./jev-handler.js";
import { rpcHandler, rpcHandlerNoTrace } from "./rpc-handler.js";

const useAnvil = process.env["ANVIL"] === "1";

/**
 * Default mock server — JEV AI + RPC both mocked.
 * When ANVIL=1, the RPC handler is omitted so real Anvil traffic flows through.
 */
export const mockServer = useAnvil
  ? setupServer(jevHandler)
  : setupServer(jevHandler, rpcHandler);

/**
 * Variant server with RPC trace disabled — forces eth_call fallback in SimulationEngine.
 * Used in simulation unit tests.
 */
export const mockServerNoTrace = setupServer(jevHandler, rpcHandlerNoTrace);

// Re-export helpers so test files have a single import point
export { setJevResponse, resetJevResponse } from "./jev-handler.js";
export { rpcHandler, rpcHandlerNoTrace } from "./rpc-handler.js";
