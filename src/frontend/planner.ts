import { FunctionCallingConfigMode, Type, type FunctionDeclaration, type GoogleGenAI } from "@google/genai";

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
by calling exactly one function. Never invent a value for any field the request doesn't
explicitly specify -- this includes placeholder-looking values ("N/A", "unknown",
"<REQUIRED>", empty string) which are just as much an invention as a fake real-looking value.
If a required argument is genuinely missing from the request, still choose the best-matching
capability and leave that argument out of your call entirely -- the invocation will fail
validation explicitly and safely, rather than silently proceeding on a made-up value. This
matters most for credential fields: never supply a username or password unless the request
states one verbatim; a missing credential should block the call, not get papered over.`;

/**
 * One model call, one function call back -- same `functionCallingConfig.mode = ANY`
 * discipline as the discovery loop (src/agent/discovery-agent.ts), for the same reason: the
 * caller needs exactly one unambiguous decision per request, not a choice among several or
 * a free-text ramble beside it.
 */
export async function planInvocation(
  genai: GoogleGenAI,
  model: string,
  capabilities: DiscoveredCapability[],
  utterance: string
): Promise<CapabilityInvocationPlan> {
  if (capabilities.length === 0) {
    throw new Error("No capabilities available to plan against -- discover at least one before invoking.");
  }

  const nameToId = new Map(capabilities.map((c) => [toFunctionName(c.id), c.id]));

  const response = await genai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: utterance }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: buildToolDeclarations(capabilities) }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
    },
  });

  const call = response.candidates?.[0]?.content?.parts?.find((p) => p.functionCall !== undefined)?.functionCall;
  if (!call?.name) {
    throw new Error("Model response contained no function call.");
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

  return { capabilityId, params, tenantId, reasoning };
}
