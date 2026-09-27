/**
 * jest.config.js — CryptoWall test suite
 *
 * Uses ts-jest in ESM mode to support:
 *   - "type": "module" in package.json
 *   - .js extension imports (ESM requirement)
 *   - nodenext module resolution in tsconfig
 *
 * Run with: node --experimental-vm-modules node_modules/.bin/jest
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/tests/**/*.test.ts"],
  setupFiles: ["./tests/jest.setup.ts"],

  // ts-jest ESM: rewrite relative .js imports from our source to .ts
  // Only matches paths containing /src/ or /tests/ to avoid rewriting node_modules internals
  moduleNameMapper: {
    "^(\\.{1,2}/(?:.*/)?(src|tests)/.+)\\.js$": "$1.ts",
    "^(\\.{1,2}/[^/]+(?:/[^/]+)*)\\.js$": [
      "$1.ts",
      "$1",
    ],
  },

  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          // Override nodenext → esnext/bundler for Jest compatibility
          module: "esnext",
          moduleResolution: "bundler",
          // Keep strict settings
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },

  // 10 s default timeout — proxy startup + MSW can be slow
  testTimeout: 10_000,

  // Show individual test names in output
  verbose: true,

  // Coverage if run with --coverage
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/server.ts",      // main entry has side effects, covered via helpers
    "!src/sdk/index.ts",   // thin factory, covered via transport tests
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 70,
    },
  },
};
