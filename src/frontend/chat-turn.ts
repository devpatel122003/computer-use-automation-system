import type { GoogleGenAI } from "@google/genai";
import { planInvocation, type CapabilityInvocationPlan, type ConversationTurn, type DiscoveredCapability } from "./planner.js";
import { redact } from "../guardrails/redaction.js";
import { redactionOptionsFor, summarize, type InvokeResponse } from "./chat-shared.js";

export interface ChatTurnOptions {
  genai: GoogleGenAI;
  models: string[];
  apiBase: string;
  apiKey: string;
  message: string;
  allowRisky?: boolean;
  /**
   * Extra params merged into the invoke call AFTER planning, taking precedence over
   * anything the model itself supplied. Exists for one reason: a customer-facing caller
   * (the chat UI) has no business ever letting a *customer's own chat text* supply a
   * credential -- see planner.ts's own reasoning for excluding sensitive params from the
   * function-calling `required` list. The chat UI fills the bank's own service-account
   * operator credential here instead; the CLI (an internal, already-authenticated caller)
   * doesn't pass this, so its behavior is unchanged.
   */
  fillParams?: Record<string, string>;
  /**
   * Prior exchanges in this same conversation, oldest first -- see `ConversationTurn`'s own
   * doc comment in planner.ts for the real multi-turn slot-filling bug this closes. The CLI
   * (one-shot `--message`) has no conversation to carry, so it never passes this; the chat
   * UI keeps it in a server-side session across turns.
   */
  history?: ConversationTurn[];
}

/**
 * `invoked` is the case that actually calls the capability API. `clarified` is the case a
 * real bug forced into existence: a message that doesn't clearly map to any capability (a
 * greeting, small talk, an incomplete request) must NOT invoke anything -- see
 * `planner.ts`'s `PlanResult` doc comment for the "hi" became a real enrollment incident
 * this closes. Both branches still redact the customer's own message before it goes
 * anywhere -- a `clarify` turn was never checked against any capability's sensitive-field
 * list, so it only gets the pattern-based (SSN/card-shaped) defense-in-depth scrub, not
 * value-based redaction, same as the discovery goal string before the password field was
 * ever "seen."
 */
export type ChatTurnResult =
  | {
      kind: "invoked";
      capabilities: DiscoveredCapability[];
      plan: CapabilityInvocationPlan;
      /** The customer's own message, redacted -- safe to log or display. */
      redactedMessage: string;
      /** The model's chosen params, redacted, BEFORE any fillParams merge -- an injected
       *  service credential should never appear in anything shown back to the caller,
       *  redacted or not, since it was never something the caller stated in the first
       *  place. */
      redactedParams: Record<string, string>;
      redactedReasoning: string;
      httpStatus: number;
      result: InvokeResponse;
      summary: string;
    }
  | {
      kind: "clarified";
      capabilities: DiscoveredCapability[];
      redactedMessage: string;
      /** The model's own conversational reply -- not templated, since there's no
       *  structured result to template it from. This is the one place in this system's
       *  conversational front end where the reply IS the model's own words, not a
       *  deterministic summary -- deliberately, since nothing was decided or executed to
       *  summarize. */
      message: string;
    };

/**
 * The "decide what to do" half of a turn, split out of `runChatTurn` so a caller (the chat
 * UI) can inspect the plan -- specifically `capability.hasRiskyStep` -- and hold it for a
 * human's explicit confirmation BEFORE `invokePlannedTurn` ever touches the capability API.
 * The CLI (`src/cli/agent-chat.ts`) doesn't need this split: it's an already-trusted internal
 * operator, so it goes through `runChatTurn`, which still plans and invokes in one call with
 * behavior unchanged from before this split existed.
 */
export type PlanChatTurnResult =
  | {
      kind: "planned";
      capabilities: DiscoveredCapability[];
      plan: CapabilityInvocationPlan;
      capability: DiscoveredCapability;
      redactedMessage: string;
      redactedParams: Record<string, string>;
      redactedReasoning: string;
    }
  | {
      kind: "clarified";
      capabilities: DiscoveredCapability[];
      redactedMessage: string;
      message: string;
    };

async function fetchCapabilities(apiBase: string, authHeaders: Record<string, string>): Promise<DiscoveredCapability[]> {
  const listRes = await fetch(`${apiBase}/capabilities`, { headers: authHeaders });
  if (!listRes.ok) throw new Error(`GET /capabilities failed: HTTP ${listRes.status}`);
  const catalog = (await listRes.json()) as Array<{
    id: string;
    description: string;
    inputParams: DiscoveredCapability["inputParams"];
    hasRiskyStep?: boolean;
  }>;
  return catalog.map((c) => ({ id: c.id, description: c.description, inputParams: c.inputParams, hasRiskyStep: c.hasRiskyStep }));
}

export async function planChatTurn(
  options: Pick<ChatTurnOptions, "genai" | "models" | "apiBase" | "apiKey" | "message" | "history" | "fillParams">
): Promise<PlanChatTurnResult> {
  const { genai, models, apiBase, apiKey, message, history, fillParams } = options;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  const capabilities = await fetchCapabilities(apiBase, authHeaders);

  // A param the caller will supply itself via fillParams (the chat UI's own operator
  // username/password) must never be presented to the model as something it needs to
  // collect from the customer at all -- not just excluded from what's shown back, as
  // `sensitive` params already are. A real bug caught live: `username` isn't marked
  // `sensitive` (only `password` is), so without this the model correctly refused to invent
  // a value for it, but that meant it just kept asking the customer for an "operator
  // username" -- a value they have no reason to know and will never be asked to actually
  // use -- blocking the entire request instead of proceeding. Filtering it out of the
  // schema entirely (not just the `required` list) means the model never even considers it.
  const fillKeys = new Set(Object.keys(fillParams ?? {}));
  const capabilitiesForPlanning =
    fillKeys.size === 0 ? capabilities : capabilities.map((c) => ({ ...c, inputParams: c.inputParams.filter((p) => !fillKeys.has(p.name)) }));

  const planResult = await planInvocation(genai, models, capabilitiesForPlanning, message, history);

  if (planResult.kind === "clarify") {
    return {
      kind: "clarified",
      capabilities,
      redactedMessage: redact(message, {}) as string,
      message: planResult.message,
    };
  }

  const plan = planResult.plan;
  const capability = capabilities.find((c) => c.id === plan.capabilityId);
  if (!capability) {
    throw new Error(`Planner chose capability "${plan.capabilityId}" that isn't in the discovered catalog.`);
  }
  const redactOpts = redactionOptionsFor(capabilities, plan);

  return {
    kind: "planned",
    capabilities,
    plan,
    capability,
    redactedMessage: redact(message, redactOpts) as string,
    redactedParams: redact(plan.params, redactOpts) as Record<string, string>,
    redactedReasoning: redact(plan.reasoning, redactOpts) as string,
  };
}

/**
 * The "actually do it" half of a turn: invoke an already-planned capability through the same
 * capability API every other caller uses, and template a deterministic summary. Takes a plan
 * produced by `planChatTurn` (either just now, for a safe capability, or held across a
 * confirmation round-trip for a risky one).
 */
export async function invokePlannedTurn(
  options: Pick<ChatTurnOptions, "apiBase" | "apiKey" | "allowRisky" | "fillParams">,
  planned: Extract<PlanChatTurnResult, { kind: "planned" }>
): Promise<Extract<ChatTurnResult, { kind: "invoked" }>> {
  const { apiBase, apiKey, allowRisky = true, fillParams } = options;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const { plan, capabilities, redactedMessage, redactedParams, redactedReasoning } = planned;

  // fillParams always wins over plan.params: even if a customer's message somehow named a
  // credential, this is a customer-facing surface and that value must never be the one
  // actually used to authenticate against the target system.
  const invokeParams = { ...plan.params, ...(fillParams ?? {}) };

  const invokeRes = await fetch(`${apiBase}/capabilities/${plan.capabilityId}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ params: invokeParams, allowRisky, tenantId: plan.tenantId }),
  });
  const result = (await invokeRes.json()) as InvokeResponse;

  return {
    kind: "invoked",
    capabilities,
    plan,
    redactedMessage,
    redactedParams,
    redactedReasoning,
    httpStatus: invokeRes.status,
    result,
    summary: summarize(result, invokeRes.status),
  };
}

/**
 * The one real implementation of "natural language in, capability invoked (or not), result
 * out" -- discover capabilities, decide whether/which one + what args (the model's only
 * job), invoke it through the exact same capability API every other caller uses if so, and
 * template a deterministic summary. Used by `src/cli/agent-chat.ts`, which always plans and
 * invokes in the same turn (no confirmation step -- see `planChatTurn`'s doc comment for why
 * the chat UI needs the split instead of this).
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const planned = await planChatTurn(options);
  if (planned.kind === "clarified") return planned;
  return invokePlannedTurn(options, planned);
}
