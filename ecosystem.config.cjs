// ─── PM2 Ecosystem — CircuitBreaker-AI ───────────────────────────────────────
// Usage:
//   pm2 start ecosystem.config.cjs              — single process
//   pm2 start ecosystem.config.cjs --env prod   — production cluster mode
//   pm2 start ecosystem.config.cjs --only circuitbreaker-audit
//
// Note: uses .cjs extension so PM2 can require() it regardless of "type":"module"

require("dotenv").config();

module.exports = {
  apps: [
    // ── Default: single process, strict policy ────────────────────────────────
    {
      name:         "circuitbreaker",
      script:       "dist/server.js",
      interpreter:  "node",
      instances:    1,
      exec_mode:    "fork",
      watch:        false,
      max_memory_restart: "512M",

      env: {
        NODE_ENV:              "development",
        PORT:                  8545,
        POLICY_MODE:           "strict",
        ANALYSIS_TIMEOUT_MS:   800,
        MAX_CONCURRENT_ANALYSES: 50,
        // JEV_API_KEY and UPSTREAM_RPC are read from .env via dotenv above
      },

      env_prod: {
        NODE_ENV:              "production",
        PORT:                  8545,
        POLICY_MODE:           "strict",
        ANALYSIS_TIMEOUT_MS:   800,
        MAX_CONCURRENT_ANALYSES: 100,
      },

      // Structured log output
      log_date_format:  "YYYY-MM-DD HH:mm:ss.SSS Z",
      out_file:  "logs/proxy-out.log",
      error_file: "logs/proxy-err.log",
      merge_logs: true,
    },

    // ── Cluster: 1 process per CPU core, strict policy ────────────────────────
    {
      name:         "circuitbreaker-cluster",
      script:       "dist/server.js",
      interpreter:  "node",
      instances:    "max",          // one per vCPU
      exec_mode:    "cluster",
      watch:        false,
      max_memory_restart: "512M",

      env_prod: {
        NODE_ENV:              "production",
        PORT:                  8545,
        POLICY_MODE:           "strict",
        ANALYSIS_TIMEOUT_MS:   800,
        MAX_CONCURRENT_ANALYSES: 100,
      },

      log_date_format:  "YYYY-MM-DD HH:mm:ss.SSS Z",
      out_file:   "logs/cluster-out.log",
      error_file: "logs/cluster-err.log",
      merge_logs: true,
    },

    // ── Audit node: never blocks, logs every decision ─────────────────────────
    {
      name:         "circuitbreaker-audit",
      script:       "dist/server.js",
      interpreter:  "node",
      instances:    1,
      exec_mode:    "fork",
      watch:        false,
      max_memory_restart: "256M",

      env_prod: {
        NODE_ENV:    "production",
        PORT:        8546,           // separate port from the gating proxy
        POLICY_MODE: "audit",
        ANALYSIS_TIMEOUT_MS: 1200,
        MAX_CONCURRENT_ANALYSES: 200,
      },

      log_date_format:  "YYYY-MM-DD HH:mm:ss.SSS Z",
      out_file:   "logs/audit-out.log",
      error_file: "logs/audit-err.log",
      merge_logs: true,
    },
  ],
};
