import { FunctionCallingConfigMode, Type, type FunctionDeclaration, type GoogleGenAI } from "@google/genai";
import { withModelFallback } from "../agent/model-retry.js";

/**
 * The other half of the sentence in REPORT.md/the brief's Section 1: "the agent-facing
 * product decides what to do; this system is how it reliably and safely does it." Every
 * other module in this repo is the second half. This is a thin, honest slice of the first
 * half -- not a general-purpose conversational agent, just enough to prove the seam: a
 * natural-language member-service request maps to "which capability, with what typed
 * args," and everything downstream of that decision (guardrails, the approval gate,
 * deterministic execution, the structured result) is the exact same capability API that
 * already exists. The model's job stops at *deciding*; it never touches execution.
 */

export interface DiscoveredCapability {
  id: string;
  description: string;
  inputParams: Array<{ name: string; type: "string" | "number" | "boolean"; required: boolean; sensitive?: boolean; description?: string }>;
}

export interface CapabilityInvocationPlan {
  capabilityId: string;
  params: Record<string, string>;
  tenantId?: string;
  reasoning: string;
}

/**
 * What the model decided to do with one request. `invoke` is the case everything downstream
 * already handles (guardrails, replay, the structured result). `clarify` is the case this
 * module didn't have until a real bug surfaced it: forcing the model to always call some
 * function (`functionCallingConfig.mode = ANY`) meant a plain greeting ("hi") got jammed into
 * whichever capability's required fields were easiest to satisfy -- literally using the word
 * "hi" as a new member's full name and actually creating one. A real chat surface gets
 * greetings, chit-chat, and incomplete requests constantly; forcing an action out of every
 * one of them is itself the bug, not a model that "isn't calling the function right."
 */
export type PlanResult = { kind: "invoke"; plan: CapabilityInvocationPlan } | { kind: "clarify"; message: string };

const GEMINI_TYPE: Record<"string" | "number" | "boolean", Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
};

/** Gemini function names must match ^[a-zA-Z_][a-zA-Z0-9_]{0,63}$ -- capability ids use
 *  hyphens (e.g. "open-sub-account"), so this is a reversible sanitization, not a rename. */
function toFunctionName(capabilityId: string): string {
  return `invoke__${capabilityId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

export function buildToolDeclarations(capabilities: DiscoveredCapability[]): FunctionDeclaration[] {
  return capabilities.map((cap) => ({
    name: toFunctionName(cap.id),
    description: `Invoke the "${cap.id}" capability: ${cap.description}`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        reasoning: { type: Type.STRING, description: "One brief sentence: why this capability and these args satisfy the request." },
        tenantId: {
          type: Type.STRING,
          description: "Which tenant/branded variant to invoke this for, ONLY if the request names one (e.g. a credit union by name). Omit otherwise.",
        },
        ...Object.fromEntries(
          cap.inputParams.map((p) => [
            p.name,
            {
              type: GEMINI_TYPE[p.type],
              description: p.sensitive
                ? `${p.description ?? ""} CREDENTIAL FIELD: never invent a value, not even a placeholder -- omit this argument entirely unless the request explicitly states it.`
                : p.description ?? "",
            },
          ])
        ),
      },
      // Deliberately excludes sensitive params even when the capability itself marks them
      // required: putting a credential field in the JSON-schema `required` list all but
      // guarantees the model invents a placeholder value to satisfy the contract (a real
      // failure mode hit while building this -- see planner.test.ts and REPORT.md). A
      // credential belongs to the calling system's authenticated session, not to a string
      // typed by whoever wrote the request; the planner's job is choosing WHAT to call, not
      // supplying HOW to authenticate.
      required: ["reasoning", ...cap.inputParams.filter((p) => p.required && !p.sensitive).map((p) => p.name)],
    },
  }));
}

const SYSTEM_PROMPT = `You are the agent-facing front end for a bank/credit-union back-office automation system.
A member-services request comes in as natural language. You do not execute anything yourself --
you only decide which one capability (function) answers the request, and with what arguments,
by calling at most one function.

Call a function ONLY when the request is clearly asking for one of the available capabilities
AND you can supply its genuinely required arguments from what the request actually says.
Never invent a value for any field the request doesn't explicitly specify -- this includes
placeholder-looking values ("N/A", "unknown", "<REQUIRED>", empty string) and, just as much,
treating unrelated words from the message itself (a greeting, a stray word) as if they were a
real field value. If a required argument is genuinely missing, either don't call any function
at all, or call the best-matching one and leave that argument out entirely -- the invocation
will fail validation explicitly and safely, rather than silently proceeding on a made-up value.

If the message is a greeting, small talk, a question about what you can do, or otherwise
doesn't clearly map to one of the available capabilities, do NOT call any function -- just
reply in plain text (briefly, one or two sentences, mentioning what you can actually help
with). Calling a function anyway "to be helpful" is exactly the mistake to avoid: it can
trigger a real action (e.g. actually enrolling a new member) using nonsense data.

Credential fields: never supply a username or password unless the request states one
verbatim; a missing credential should block the call, not get papered over.
When a request states a dollar amount, supply only the plain numeric value with no currency
symbol, comma, or unit (e.g. "100" for "$100" or "one hundred dollars") -- the field this
becomes is validated as a plain number downstream, and a literal "$100" is not one.`;

/**
 * One model call, at most one function call back. Deliberately `AUTO`, not `ANY`: forcing a
 * function call on every turn is what let a bare "hi" get treated as a real enrollment
 * request (see `PlanResult`'s own doc comment) -- the model needs a real way to decide
 * "nothing here" without that being an error.
 */
export async function planInvocation(
  genai: GoogleGenAI,
  models: string[],
  capabilities: DiscoveredCapability[],
  utterance: string
): Promise<PlanResult> {
  if (capabilities.length === 0) {
    throw new Error("No capabilities available to plan against -- discover at least one before invoking.");
  }

  const nameToId = new Map(capabilities.map((c) => [toFunctionName(c.id), c.id]));

  // Same transient-failure resilience the discovery loop has always had (src/agent/
  // model-retry.ts) -- hit for real, repeatedly, while producing evidence for this exact
  // module; a single 429/503 blip shouldn't fail the whole plan when a short backoff would
  // ride it out. Falls back across `models` on a daily-quota exhaustion, same as discovery.
  const response = await withModelFallback(models, (model) =>
    genai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: utterance }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: buildToolDeclarations(capabilities) }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      },
    })
  );

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const call = parts.find((p) => p.functionCall !== undefined)?.functionCall;

  if (!call?.name) {
    // AUTO mode means "no function call" is a real, expected outcome, not an error -- the
    // model chose to just talk. Fall back to a generic line if it somehow didn't include
    // one, but that's the fallback, not the reasoning we're relying on here.
    const text = parts.find((p) => typeof p.text === "string" && !p.thought)?.text;
    return { kind: "clarify", message: text?.trim() || "I'm not sure how to help with that -- could you rephrase, or ask me to look up or open something specific?" };
  }

  const capabilityId = nameToId.get(call.name);
  if (!capabilityId) {
    throw new Error(`Model called unknown function "${call.name}".`);
  }

  const args = { ...(call.args ?? {}) } as Record<string, unknown>;
  const reasoning = String(args.reasoning ?? "");
  const tenantId = typeof args.tenantId === "string" && args.tenantId ? args.tenantId : undefined;
  delete args.reasoning;
  delete args.tenantId;

  // Everything else the model supplied becomes the capability's typed params -- coerced to
  // strings because that's the invoke API's own param contract (src/api/server.ts), which
  // mirrors the artifact schema's string-typed params carrying their own declared type.
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) params[key] = String(value);
  }

  return { kind: "invoke", plan: { capabilityId, params, tenantId, reasoning } };
}
