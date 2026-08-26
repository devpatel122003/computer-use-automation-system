import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";
import { runChatTurn } from "../frontend/chat-turn.js";
import { resolveModelList } from "../agent/model-retry.js";
import { requestLog } from "../http/request-log.js";

/**
 * The other half of Section 1's sentence, made real with an actual UI instead of a CLI:
 * "the agent-facing product decides what to do; this system is how it reliably and safely
 * does it." A member types (or speaks) a plain-language request -- "open a savings account
 * for member 10001 with $100" -- and this is the thin, honest front door that turns that
 * into a capability invocation through the exact same `runChatTurn()` -> capability API ->
 * `replay()` -> guardrails path `src/cli/agent-chat.ts` already uses. No new execution
 * logic lives here; this file is the part of the system a bank's own customer-facing
 * product would actually own, demonstrating the seam rather than replacing it.
 *
 * Deliberately unauthenticated at the HTTP layer, unlike the capability API and dashboard:
 * a real bank customer opening a chat widget doesn't carry a bearer token or a Basic-auth
 * password. `GEMINI_API_KEY`/`CAPABILITY_API_KEY` stay server-side -- read from this
 * process's own environment, never sent to or exposed in the browser -- so the security
 * boundary this repo already relies on (SECURITY.md: only code that already holds the
 * capability API key can call it) is unchanged; this server is simply one more legitimate
 * holder of that key, same as the CLI.
 *
 * Two things a real production version of this would need that this demo deliberately
 * doesn't build (same "one caller class per surface, not a full identity system" posture
 * SECURITY.md already discloses for the capability API and dashboard):
 *   1. Real customer identity/session -- knowing WHICH member is chatting, rather than
 *      asking them to state their own member ID in plain text. Out of scope here on
 *      purpose; building a session/auth layer for a demo customer never really has has no
 *      real payoff.
 *   2. The operator credential problem, solved here rather than deferred: the underlying
 *      capability still needs to sign on to the back-office system as SOME authenticated
 *      operator. A real bank customer would never know (or need to know) that operator's
 *      password -- so this server injects its OWN configured service-account credential
 *      (CHAT_UI_OPERATOR_USERNAME/PASSWORD) via runChatTurn's `fillParams`, which always
 *      wins over anything the model itself proposed. The customer's chat text is never
 *      trusted for a credential, mirroring exactly why planner.ts excludes sensitive
 *      params from its function-calling `required` list in the first place.
 */

const MODELS = resolveModelList();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPERATOR_USERNAME = process.env.CHAT_UI_OPERATOR_USERNAME ?? "demo_operator";
const OPERATOR_PASSWORD = process.env.CHAT_UI_OPERATOR_PASSWORD ?? "demo_password";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json());
app.use(requestLog("chat-ui"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Unauthenticated by design (see header comment) but still rate-limited: an invocation can
// trigger a real, guardrail-checked action against the target system, and this is the one
// HTTP surface in this repo with no credential gate at all in front of it.
const chatLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.post("/chat", chatLimiter, async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing 'message'." });
    return;
  }
  if (!process.env.GEMINI_API_KEY || !process.env.CAPABILITY_API_KEY) {
    res.status(500).json({ error: "Server is not configured (missing GEMINI_API_KEY or CAPABILITY_API_KEY)." });
    return;
  }

  try {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const apiBase = process.env.CAPABILITY_API_BASE ?? "http://localhost:4700";

    const turn = await runChatTurn({
      genai,
      models: MODELS,
      apiBase,
      apiKey: process.env.CAPABILITY_API_KEY,
      message,
      fillParams: { username: OPERATOR_USERNAME, password: OPERATOR_PASSWORD },
    });

    if (turn.kind === "clarified") {
      // No capability matched clearly enough to act on -- nothing was invoked. See
      // planner.ts's PlanResult for the real incident (a bare "hi" creating a member) this
      // closes; the model's own reply goes straight back, since there's no structured
      // result to template a deterministic one from.
      res.json({ reply: turn.message });
      return;
    }

    res.json({
      reply: turn.summary,
      plan: { capabilityId: turn.plan.capabilityId, tenantId: turn.plan.tenantId, reasoning: turn.redactedReasoning, params: turn.redactedParams },
      httpStatus: turn.httpStatus,
      result: turn.result,
    });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    // "fetch failed" (Node's undici) is exactly what a refused connection looks like -- this
    // server has no other reason to see it, since runChatTurn's own errors (bad capability
    // catalog response, etc.) already carry a more specific message. Almost always means the
    // capability API (and, transitively, mock-bank) isn't actually running yet -- the single
    // most common way to see this endpoint "not work" is starting only the chat UI on its own.
    const hint = /fetch failed/i.test(messageText)
      ? ` -- is it running? (npm run mock-bank, then npm run capability-api, then this)`
      : "";
    res.status(502).json({ error: `Couldn't reach the capability API at ${process.env.CAPABILITY_API_BASE ?? "http://localhost:4700"}: ${messageText}${hint}` });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.CHAT_UI_PORT ?? 4800);
app.listen(PORT, () => {
  console.log(`Chat UI listening on http://localhost:${PORT}`);
});
