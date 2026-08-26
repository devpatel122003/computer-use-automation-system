import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { runChatTurn } from "../frontend/chat-turn.js";
import { parseArgs } from "./args.js";
import { resolveModelList } from "../agent/model-retry.js";

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
 *
 * The actual discover -> plan -> invoke sequence lives in `src/frontend/chat-turn.ts` now,
 * shared with the customer-facing chat UI (`src/chat-ui/server.ts`) -- this file is just
 * the CLI's own argument parsing and console output around that one shared implementation.
 */

// Re-exported for backward compatibility: this file's own tests (agent-chat.test.ts)
// import these from here, and other internal callers may too. The real definitions live in
// ../frontend/chat-shared.ts now, alongside runChatTurn's other shared pieces.
export { redactionOptionsFor, summarize, type InvokeResponse } from "../frontend/chat-shared.js";

const MODELS = resolveModelList();

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

  console.log(`Discovering capabilities: GET ${apiBase}/capabilities`);
  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const turn = await runChatTurn({ genai, models: MODELS, apiBase, apiKey: process.env.CAPABILITY_API_KEY, message, allowRisky });

  // Redact before printing anything, not after: the raw utterance itself can carry a
  // credential in plain English (e.g. "using password demo_password..."), the same real
  // leak the discovery agent's own goal string had (see REPORT.md "Safety") -- runChatTurn
  // already computed the redacted versions before this file ever sees them.
  console.log(`\nRequest: "${turn.redactedMessage}"`);
  console.log(
    `Plan: invoke "${turn.plan.capabilityId}"${turn.plan.tenantId ? ` for tenant "${turn.plan.tenantId}"` : ""} with ${JSON.stringify(turn.redactedParams)}`
  );
  console.log(`Reasoning: ${turn.redactedReasoning}`);

  console.log(`\nHTTP ${turn.httpStatus}`);
  console.log(JSON.stringify(turn.result, null, 2));
  console.log(`\n${turn.summary}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
