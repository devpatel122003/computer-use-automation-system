import type { Action, ActionResult, StateSnapshot } from "../surface/types.js";
import type { RiskLevel } from "../guardrails/allowlist.js";

export interface DiscoveryStep {
  stepIndex: number;
  observation: StateSnapshot;
  rationale?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  action?: Action;
  actionResult?: ActionResult;
  risk?: RiskLevel;
}

export type DiscoveryStatus = "finished" | "escalated" | "max_steps" | "dead_end" | "error";

export interface DiscoveryResult {
  status: DiscoveryStatus;
  goal: string;
  startUrl: string;
  steps: DiscoveryStep[];
  outputs: Record<string, string>;
  finalSummary?: string;
  escalationReason?: string;
}
