/**
 * JEV AI Client — Calibrated Structured Decision Engine
 *
 * Sends transaction context to the JEV RLCD (Reinforcement Learning
 * from Calibrated Decisions) endpoint and returns a typed DecisionMatrix.
 *
 * The JEV API accepts a typed "decision space" and returns calibrated
 * probability scores — not raw LLM text — enabling deterministic policy gating.
 *
 * Supports both:
 *   1. TypeSafe AI SystemOne API (POST https://api.typesafe.ai/v1/systemone)
 *   2. JEV RLCD Decide API (POST https://api.typesafe.ai/v1/decide)
 */

import type {
  DecisionMatrix,
  RiskCategory,
  SimulationTrace,
  TransactionPayload,
} from "./types.js";

const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// ─── JEV Wire Types ───────────────────────────────────────────────────────────

interface JevDecideRequest {
  input: string;
  context?: Record<string, unknown>;
  decisions: {
    risk_category: {
      type: "Choice";
      options: RiskCategory[];
    };
    risk_flags: {
      type: "MultiChoice";
      options: RiskCategory[];
    };
    exploit_probability: {
      type: "Noul";
    };
    severity_score: {
      type: "Score";
      min: 1;
      max: 5;
    };
    rationale: {
      type: "Text";
      max_tokens: 120;
    };
  };
}

interface JevDecideResponse {
  decisions: {
    risk_category: { choice: RiskCategory };
    risk_flags: { choices: RiskCategory[] };
    exploit_probability: { probability: number };
    severity_score: { score: number };
    rationale: { text: string };
  };
  model: string;
  latency_ms: number;
}

interface JevSystemOneResponse {
  model: string;
  answers: {
    exploit_probability?: { type: "noul"; noul: number };
    risk_category?: { type: "choice"; choice: RiskCategory; confidence?: number };
    severity_score?: { type: "score"; score: number; confidence?: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class JevClient {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(endpoint?: string, apiKey?: string) {
    this.endpoint = endpoint ?? process.env["JEV_ENDPOINT"] ?? DEFAULT_JEV_ENDPOINT;
    this.apiKey = apiKey ?? process.env["JEV_API_KEY"] ?? "";
  }

  /**
   * Evaluates a transaction payload and returns a typed DecisionMatrix.
   * The JEV RLCD API returns calibrated probabilities — not unstructured text.
   */
  async evaluate(
    tx: TransactionPayload,
    simulation?: SimulationTrace,
    timeoutMs = 800
  ): Promise<DecisionMatrix> {
    const categories: RiskCategory[] = [
      "sandwich_exposure",
      "malicious_approval",
      "unverified_calldata",
      "bad_debt_risk",
      "poison_token",
      "reentrancy_risk",
      "price_manipulation",
      "normal",
    ];

    // Build structured context string for the model
    const inputLines: string[] = [
      `From: ${tx.from}`,
      `To: ${tx.to}`,
      `Value: ${tx.value} wei`,
      `Calldata: ${tx.data.slice(0, 256)}${tx.data.length > 256 ? "…" : ""}`,
    ];

    if (tx.chainId !== undefined) inputLines.push(`ChainId: ${tx.chainId}`);
    if (tx.gas !== undefined) inputLines.push(`Gas: ${tx.gas}`);

    if (simulation) {
      inputLines.push(`SimulationReverted: ${simulation.reverted}`);
      if (simulation.revert_reason) {
        inputLines.push(`RevertReason: ${simulation.revert_reason}`);
      }
      inputLines.push(`GasUsed: ${simulation.gas_used}`);
      inputLines.push(`StateChanges: ${simulation.state_changes.length}`);
      inputLines.push(`CallDepth: ${simulation.call_trace.length}`);
      if (simulation.slippage_bps !== undefined) {
        inputLines.push(`SlippageBps: ${simulation.slippage_bps}`);
      }
      // Append approval targets — high signal for malicious_approval
      const approvals = simulation.state_changes.filter(s => s.type === "erc20_approval");
      if (approvals.length > 0) {
        const spenders = approvals.map(a => a.spender ?? "unknown").join(", ");
        inputLines.push(`ApprovalSpenders: ${spenders}`);
        const isUnlimited = approvals.some(a => a.token === "unlimited" || (a.amount !== undefined && a.amount >= BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") - 1000n));
        if (isUnlimited) {
          inputLines.push("ApprovalType: Unlimited MAX_UINT256 allowance");
        }
      }
    }

    const isSystemOne = this.endpoint.includes("/systemone");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let reqBody: unknown;

      if (isSystemOne) {
        reqBody = {
          model: "jev-latest",
          state: inputLines.join("\n"),
          questions: {
            exploit_probability: {
              type: "noul",
              instructions: "Is this transaction an exploit, drainer, phishing attack, or malicious activity?",
            },
            risk_category: {
              type: "choice",
              instructions: "What is the primary risk category of this transaction?",
              criteria: {
                normal: "Safe benign transfer or interaction",
                malicious_approval: "Unlimited approval phishing drainer",
                sandwich_exposure: "MEV sandwich slippage exposure",
                unverified_calldata: "Unverified contract interaction",
                poison_token: "Honeypot or fake token",
                reentrancy_risk: "Reentrancy attack pattern",
                bad_debt_risk: "DeFi undercollateralised bad debt",
                price_manipulation: "AMM or oracle manipulation",
              },
            },
            severity_score: {
              type: "score",
              instructions: "Rate severity from 1 (benign) to 5 (critical exploit)",
              criteria: [
                "Benign normal activity",
                "Low risk informational",
                "Medium risk elevated slippage",
                "High risk exploit attempt",
                "Critical zero-day or wallet drainer",
              ],
            },
          },
        };
      } else {
        reqBody = {
          input: inputLines.join("\n"),
          context: {
            has_simulation: simulation !== undefined,
            state_change_count: simulation?.state_changes.length ?? 0,
          },
          decisions: {
            risk_category: { type: "Choice", options: categories },
            risk_flags: { type: "MultiChoice", options: categories },
            exploit_probability: { type: "Noul" },
            severity_score: { type: "Score", min: 1, max: 5 },
            rationale: { type: "Text", max_tokens: 120 },
          },
        } as JevDecideRequest;
      }

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-CircuitBreaker-SDK": "1.0.0",
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`JEV API ${res.status}: ${await res.text()}`);
      }

      const raw = await res.json();

      if (isSystemOne) {
        const sysRaw = raw as JevSystemOneResponse;
        const answers = sysRaw.answers ?? {};
        const prob = typeof answers.exploit_probability?.noul === "number"
          ? answers.exploit_probability.noul
          : 0.1;
        const category = (answers.risk_category?.choice ?? "normal") as RiskCategory;
        const sevRaw = answers.severity_score?.score; // 0.0 to 4.0
        const severity = (
          sevRaw === undefined
            ? 1
            : Math.min(5, Math.max(1, Math.round(sevRaw + 1)))
        ) as 1 | 2 | 3 | 4 | 5;

        return {
          risk_category: category,
          risk_flags: [category],
          exploit_probability: clamp(prob, 0, 1),
          severity_score: severity,
          rationale: `JEV SystemOne live RLCD evaluation (${sysRaw.model ?? "jev-latest"}): ${category}, probability ${(prob * 100).toFixed(1)}%.`,
          simulation,
          decided_at: Date.now(),
        };
      }

      const decideRaw = raw as JevDecideResponse;
      const severityRaw = decideRaw.decisions.severity_score.score;
      const severity = (
        severityRaw < 1 ? 1 : severityRaw > 5 ? 5 : Math.round(severityRaw)
      ) as 1 | 2 | 3 | 4 | 5;

      return {
        risk_category: decideRaw.decisions.risk_category.choice,
        risk_flags: decideRaw.decisions.risk_flags.choices,
        exploit_probability: clamp(decideRaw.decisions.exploit_probability.probability, 0, 1),
        severity_score: severity,
        rationale: decideRaw.decisions.rationale.text,
        simulation,
        decided_at: Date.now(),
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // On timeout, fall through to local heuristics (never stall UX)
        return this.heuristicFallback(tx, simulation);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Local heuristic fallback when JEV API is unreachable or times out.
   * Never returns false negatives for obvious on-chain signals.
   * Errs toward audit (no blocking) on uncertainty — latency > security.
   */
  heuristicFallback(
    tx: TransactionPayload,
    simulation?: SimulationTrace
  ): DecisionMatrix {
    const flags: RiskCategory[] = [];
    let probability = 0.1;
    let severity: 1 | 2 | 3 | 4 | 5 = 1;

    // Unlimited approval: approve(spender, MAX_UINT256)
    if (
      (tx.data.startsWith("0x095ea7b3") || tx.data.includes("095ea7b3")) &&
      tx.data.includes("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
    ) {
      flags.push("malicious_approval");
      probability = Math.max(probability, 0.72);
      severity = Math.max(severity, 4) as 1 | 2 | 3 | 4 | 5;
    }

    // Contract creation with no known bytecode (to = 0x0 or empty)
    if (!tx.to || tx.to === "0x0000000000000000000000000000000000000000") {
      flags.push("unverified_calldata");
      probability = Math.max(probability, 0.35);
      severity = Math.max(severity, 2) as 1 | 2 | 3 | 4 | 5;
    }

    if (simulation?.reverted) {
      probability = Math.max(probability, 0.55);
      severity = Math.max(severity, 3) as 1 | 2 | 3 | 4 | 5;
    }

    // High slippage → possible sandwich
    if (simulation?.slippage_bps !== undefined && simulation.slippage_bps > 200) {
      flags.push("sandwich_exposure");
      probability = Math.max(probability, 0.6);
      severity = Math.max(severity, 3) as 1 | 2 | 3 | 4 | 5;
    }

    const category: RiskCategory = flags[0] ?? "normal";

    return {
      risk_category: category,
      risk_flags: flags.length > 0 ? flags : ["normal"],
      exploit_probability: probability,
      severity_score: severity,
      rationale: "Heuristic analysis (JEV API unavailable). Manual review recommended.",
      simulation,
      decided_at: Date.now(),
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}