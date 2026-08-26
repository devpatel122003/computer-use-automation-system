import type { DiscoveredCapability } from "./planner.js";

/**
 * Shared between every caller of the capability API's conversational front end -- the CLI
 * (`src/cli/agent-chat.ts`) and the customer-facing chat UI (`src/chat-ui/server.ts`).
 * Moved out of the CLI specifically so the two never end up with two slightly different
 * ideas of "what counts as sensitive" or "how do we phrase a business outcome" -- the same
 * "one implementation, not two" discipline the rest of this repo applies to guardrails and
 * locator resolution.
 */

export interface InvokeResponse {
  status: "success" | "business_outcome" | "failure";
  outputs?: Record<string, string>;
  outcome?: string;
  description?: string;
  stepId?: string;
  expected?: string;
  observed?: string;
  evidenceRef?: string;
  error?: string;
}

/**
 * Which param names/values must never reach a log or a UI in the clear, for a given plan.
 * Kept as its own pure function specifically so the redaction decision is unit-testable
 * without a live Gemini call.
 */
export function redactionOptionsFor(
  capabilities: DiscoveredCapability[],
  plan: { capabilityId: string; params: Record<string, string> }
): { sensitiveKeys: Set<string>; sensitiveValues: Set<string> } {
  const chosenCapability = capabilities.find((c) => c.id === plan.capabilityId);
  const sensitiveKeys = new Set((chosenCapability?.inputParams ?? []).filter((p) => p.sensitive).map((p) => p.name));
  const sensitiveValues = new Set(
    Object.entries(plan.params)
      .filter(([k]) => sensitiveKeys.has(k))
      .map(([, v]) => v)
  );
  return { sensitiveKeys, sensitiveValues };
}

export function summarize(response: InvokeResponse, httpStatus: number): string {
  if (httpStatus >= 400 && response.error) {
    return `Couldn't even start: ${response.error}`;
  }
  if (response.status === "success") {
    const outputs = response.outputs ?? {};
    const outputText = Object.entries(outputs).map(([k, v]) => `${k} = ${v}`).join(", ");
    return `Done.${outputText ? ` ${outputText}.` : ""}`;
  }
  if (response.status === "business_outcome") {
    return `Completed, but the answer is "${response.outcome}": ${response.description}`;
  }
  return `Didn't complete. At step ${response.stepId}, expected ${response.expected} but observed ${response.observed}.`;
}
