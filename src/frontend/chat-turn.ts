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

export interface ChatTurnResult {
  capabilities: DiscoveredCapability[];
  plan: CapabilityInvocationPlan;
  /** The customer's own message, redacted -- safe to log or display. */
  redactedMessage: string;
  /** The model's chosen params, redacted, BEFORE any fillParams merge -- an injected
   *  service credential should never appear in anything shown back to the caller, redacted
   *  or not, since it was never something the caller stated in the first place. */
  redactedParams: Record<string, string>;
  redactedReasoning: string;
  httpStatus: number;
  result: InvokeResponse;
  summary: string;
}

/**
 * The one real implementation of "natural language in, capability invoked, structured
 * result out" -- discover capabilities, decide which one + what args (the model's only
 * job), invoke it through the exact same capability API every other caller uses, and
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

  const plan = await planInvocation(genai, models, capabilities, message);
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
