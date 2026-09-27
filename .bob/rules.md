# CircuitBreaker-AI Project Rules
- Model Stack: TypeSafe Jev (RLCD) for non-autoregressive calibrated decisions.
- Web3 Stack: Viem & Fastify (JSON-RPC Reverse Proxy).
- Deterministic Guardrails: 
  - If `exploit_confidence` > 0.85 -> REJECT_TX
  - If `0.40 <= exploit_confidence <= 0.85` -> REQUIRE_SIMULATION
  - If `exploit_confidence` < 0.40 -> FORWARD_RPC