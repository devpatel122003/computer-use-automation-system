import { planChatTurn, type ChatTurnOptions, type PlanChatTurnResult } from "./chat-turn.js";
import type { ConversationTurn } from "./planner.js";
import { findChainMapping, type ChainMapping } from "./chain-mappings.js";

/**
 * Multi-step chained chat requests -- e.g. "create a new member named Dave, then open a
 * savings account for them with $100." Deliberately NOT a model-driven multi-call: a single
 * Gemini turn can't produce step 2's real `memberId` at plan time, since it doesn't exist
 * until step 1 actually runs -- asking the model to supply one anyway would reintroduce
 * exactly the "invent a plausible-looking value" failure mode already fixed once in this
 * project (see planner.ts's own system prompt). So chain DETECTION is a pure, deterministic
 * text split, with no model call and no real value at stake -- always safe to fall back
 * from into the existing single-turn path if anything about it doesn't line up.
 *
 * Zero edits to chat-turn.ts/planner.ts: this is an orchestration layer one level up, built
 * entirely out of the existing, unmodified `planChatTurn()` called twice.
 */

const CONNECTOR_RE = /,?\s+(?:and then|after that|once that'?s done|then)\s+/i;

/** Splits on a small, fixed set of sequencing connectors. Splitting the TEXT (not just
 *  detecting chaining intent) matters: it stops the first clause's planning call from being
 *  tempted to pull data meant for the second clause into its own fields (e.g. a dollar
 *  amount meant for `open-sub-account`'s deposit ending up in `create-member`'s own
 *  `initialSavings`). Returns null (not a chain) if there's no connector, or either
 *  resulting half is empty/whitespace-only. */
export function splitChainedUtterance(message: string): { first: string; second: string } | null {
  const match = CONNECTOR_RE.exec(message);
  if (!match) return null;

  const first = message.slice(0, match.index).trim();
  const second = message.slice(match.index + match[0].length).trim();
  if (!first || !second) return null;

  return { first, second };
}

// A real bug caught live against real Gemini, not a hypothetical: planning the second
// clause completely in isolation ("open a savings account for them with $100") made the
// model correctly refuse to call ANY function at all -- with no concrete member reference,
// it judged the request too unclear rather than inventing a value or omitting the field,
// coming back `clarify` instead of a real plan. This placeholder gives it something
// syntactically concrete to anchor "memberId" on, so it reliably still picks the right
// capability and fills every OTHER field correctly from the clause. It is never trusted as
// real data: whatever the model does with it, `toField` is unconditionally overwritten with
// step 1's actual output before step 2 is ever invoked (see the /chat handler). All four
// current CHAIN_MAPPINGS rows target "memberId" specifically, which is why this is a single
// fixed hint rather than something derived per-mapping -- a future mapping targeting a
// different field would need its own hint text, not just a different placeholder value.
const MEMBER_ID_PLACEHOLDER_HINT = " (the member ID for this request is CHAIN-STEP-1-MEMBER-ID)";

export type ChainPlanResult =
  | { kind: "not-chain" }
  | {
      kind: "chained";
      step1: Extract<PlanChatTurnResult, { kind: "planned" }>;
      step2: Extract<PlanChatTurnResult, { kind: "planned" }>;
      mapping: ChainMapping;
    };

/**
 * Plans both clauses of a (possibly) chained message. `not-chain` -- always a safe,
 * unsurprising fallback, never a hard error -- covers: no connector found; either clause
 * came back `clarified` rather than a real plan; or the two chosen capabilities have no
 * row in `CHAIN_MAPPINGS` (an unmapped pair is data this project has no verified
 * output->input relationship for, not something worth guessing at).
 */
export async function planChainedTurn(
  options: Pick<ChatTurnOptions, "genai" | "models" | "apiBase" | "apiKey" | "fillParams">,
  message: string,
  history: ConversationTurn[] = []
): Promise<ChainPlanResult> {
  const split = splitChainedUtterance(message);
  if (!split) return { kind: "not-chain" };

  const [step1, step2] = await Promise.all([
    planChatTurn({ ...options, message: split.first, history }),
    planChatTurn({ ...options, message: split.second + MEMBER_ID_PLACEHOLDER_HINT, history }),
  ]);

  if (step1.kind !== "planned" || step2.kind !== "planned") return { kind: "not-chain" };

  const mapping = findChainMapping(step1.plan.capabilityId, step2.plan.capabilityId);
  if (!mapping) return { kind: "not-chain" };

  return { kind: "chained", step1, step2, mapping };
}
