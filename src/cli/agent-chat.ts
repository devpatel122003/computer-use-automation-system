import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { planInvocation, type DiscoveredCapability } from "../frontend/planner.js";
import { redact } from "../guardrails/redaction.js";
import { parseArgs } from "./args.js";

/**
 * The conversational front end this repo was missing: takes a natural-language
 * member-service request, decides which capability + typed args answer it (the model's
 * only job -- see src/frontend/planner.ts), then calls the exact same capability API
 * every other invocation path uses. Deliberately NOT a second LLM call to phrase the
 * final response: success/business_outcome/failure are templated deterministically from
 * the structured result, the same "the model decides, execution and reporting stay
 * deterministic" split the whole system is built around -- an extra LLM call to restate a
 * result that's already fully structured would just be latency, cost, and a new
 * hallucination surface for zero benefit.
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";

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
 * Which param names/values must never reach stdout in the clear, for a given plan. Kept as
 * its own pure function (rather than inline in main()) specifically so the redaction
 * decision is unit-testable without a live Gemini call.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = args["api-base"] ?? "http://localhost:4700";
  const message = args.message;
  const allowRisky = args["allow-risky"] !== "false";

  if (!message) {
    console.error('Usage: npm run agent-chat -- --message "open a savings account for member 10001 with $100"');
    process.exitCode = 1;
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Export it or add it to a .env file (see README.md).");
    process.exitCode = 1;
    return;
  }
  if (!process.env.CAPABILITY_API_KEY) {
    console.error("CAPABILITY_API_KEY is not set. Export it or add it to a .env file (see .env.example) -- it must match the key the capability API was started with.");
    process.exitCode = 1;
    return;
  }
  const authHeaders = { Authorization: `Bearer ${process.env.CAPABILITY_API_KEY}` };

  console.log(`Discovering capabilities: GET ${apiBase}/capabilities`);
  const listRes = await fetch(`${apiBase}/capabilities`, { headers: authHeaders });
  if (!listRes.ok) throw new Error(`GET /capabilities failed: HTTP ${listRes.status}`);
  const catalog = (await listRes.json()) as Array<{ id: string; description: string; inputParams: DiscoveredCapability["inputParams"] }>;
  const capabilities: DiscoveredCapability[] = catalog.map((c) => ({ id: c.id, description: c.description, inputParams: c.inputParams }));

  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const plan = await planInvocation(genai, DEFAULT_MODEL, capabilities, message);

  // Redact before printing anything, not after: the raw utterance itself can carry a
  // credential in plain English (e.g. "using password demo_password..."), the same real
  // leak the discovery agent's own goal string had (see REPORT.md "Safety") -- so the
  // sensitive param names/values have to be known and registered *before* the first
  // console.log, not just before sending the params over the wire.
  const redactOpts = redactionOptionsFor(capabilities, plan);

  console.log(`\nRequest: "${redact(message, redactOpts)}"`);
  console.log(
    `Plan: invoke "${plan.capabilityId}"${plan.tenantId ? ` for tenant "${plan.tenantId}"` : ""} with ${JSON.stringify(redact(plan.params, redactOpts))}`
  );
  console.log(`Reasoning: ${redact(plan.reasoning, redactOpts)}`);

  const invokeRes = await fetch(`${apiBase}/capabilities/${plan.capabilityId}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ params: plan.params, allowRisky, tenantId: plan.tenantId }),
  });
  const result = (await invokeRes.json()) as InvokeResponse;

  console.log(`\nHTTP ${invokeRes.status}`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n${summarize(result, invokeRes.status)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
