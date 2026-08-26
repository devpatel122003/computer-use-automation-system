import type { GoogleGenAI } from "@google/genai";
import { planInvocation, type CapabilityInvocationPlan, type DiscoveredCapability } from "./planner.js";
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
 * The one real implementation of "natural language in, capability invoked (or not), result
 * out" -- discover capabilities, decide whether/which one + what args (the model's only
 * job), invoke it through the exact same capability API every other caller uses if so, and
 * template a deterministic summary. Used by both `src/cli/agent-chat.ts` and
 * `src/chat-ui/server.ts` so there is exactly one place this sequence is implemented.
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { genai, models, apiBase, apiKey, message, allowRisky = true, fillParams } = options;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  const listRes = await fetch(`${apiBase}/capabilities`, { headers: authHeaders });
  if (!listRes.ok) throw new Error(`GET /capabilities failed: HTTP ${listRes.status}`);
  const catalog = (await listRes.json()) as Array<{ id: string; description: string; inputParams: DiscoveredCapability["inputParams"] }>;
  const capabilities: DiscoveredCapability[] = catalog.map((c) => ({ id: c.id, description: c.description, inputParams: c.inputParams }));

  const planResult = await planInvocation(genai, models, capabilities, message);

  if (planResult.kind === "clarify") {
    return {
      kind: "clarified",
      capabilities,
      redactedMessage: redact(message, {}) as string,
      message: planResult.message,
    };
  }

  const plan = planResult.plan;
  const redactOpts = redactionOptionsFor(capabilities, plan);

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
    redactedMessage: redact(message, redactOpts) as string,
    redactedParams: redact(plan.params, redactOpts) as Record<string, string>,
    redactedReasoning: redact(plan.reasoning, redactOpts) as string,
    httpStatus: invokeRes.status,
    result,
    summary: summarize(result, invokeRes.status),
  };
}
