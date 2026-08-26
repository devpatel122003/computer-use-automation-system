import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import { GoogleGenAI } from "@google/genai";
import { planChatTurn, invokePlannedTurn, type PlanChatTurnResult } from "../frontend/chat-turn.js";
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

// Holds a planned-but-not-yet-invoked risky capability call across exactly one confirmation
// round-trip -- see the /chat handler below. A memory-backed session (express-session's
// default store, same posture as mock-bank's own login session) is enough for a demo: this
// is a single process, and losing a pending plan on restart just means re-asking the
// question, not a correctness problem.
declare module "express-session" {
  interface SessionData {
    pendingPlan?: Extract<PlanChatTurnResult, { kind: "planned" }>;
  }
}

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json());
app.use(
  session({
    secret: process.env.CHAT_UI_SESSION_SECRET ?? "chat-ui-dev-secret-not-sensitive",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 15 },
  })
);
app.use(requestLog("chat-ui"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Unauthenticated by design (see header comment) but still rate-limited: an invocation can
// trigger a real, guardrail-checked action against the target system, and this is the one
// HTTP surface in this repo with no credential gate at all in front of it.
const chatLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

const AFFIRMATIVE_RE = /^(y|yes|yeah|yep|yup|confirm|confirmed|go ahead|do it|proceed|sure|ok|okay)[.! ]*$/i;
const NEGATIVE_RE = /^(n|no|nope|cancel|nevermind|never mind|stop|don'?t|abort)[.! ]*$/i;

function describePendingPlan(planned: Extract<PlanChatTurnResult, { kind: "planned" }>, hiddenParamNames: Set<string>): string {
  // A field like "username" is required by the capability's own schema but isn't marked
  // `sensitive` (that flag governs redaction, not who's allowed to supply it) -- so a real
  // model call can invent a blank placeholder for it despite the planner's system prompt
  // telling it not to (caught live: a bare "create a member" request produced a
  // confirmation reading "username: "). It's always overwritten by fillParams before
  // invoking regardless, so showing it here is pure noise, not a real value to confirm.
  const paramList = Object.entries(planned.redactedParams)
    .filter(([k]) => !hiddenParamNames.has(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const tenantNote = planned.plan.tenantId ? ` for tenant "${planned.plan.tenantId}"` : "";
  return (
    `Before I go ahead: I'm about to run **${planned.plan.capabilityId}**${tenantNote}` +
    (paramList ? ` with ${paramList}.` : ".") +
    ` Reply "yes" to confirm or "no" to cancel.`
  );
}

function invokedTurnResponse(turn: Awaited<ReturnType<typeof invokePlannedTurn>>) {
  return {
    reply: turn.summary,
    plan: { capabilityId: turn.plan.capabilityId, tenantId: turn.plan.tenantId, reasoning: turn.redactedReasoning, params: turn.redactedParams },
    httpStatus: turn.httpStatus,
    result: turn.result,
  };
}

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
    const apiKey = process.env.CAPABILITY_API_KEY;
    const fillParams = { username: OPERATOR_USERNAME, password: OPERATOR_PASSWORD };

    // A pending risky plan from a PREVIOUS turn takes priority over re-planning this
    // message from scratch: this message's only job right now is to confirm, cancel, or
    // (implicitly, by saying something else entirely) supersede that plan.
    const pending = req.session.pendingPlan;
    if (pending) {
      if (AFFIRMATIVE_RE.test(message)) {
        req.session.pendingPlan = undefined;
        const turn = await invokePlannedTurn({ apiBase, apiKey, fillParams }, pending);
        res.json(invokedTurnResponse(turn));
        return;
      }
      if (NEGATIVE_RE.test(message)) {
        req.session.pendingPlan = undefined;
        res.json({ reply: "Okay, I won't go ahead with that. Let me know if there's something else I can help with." });
        return;
      }
      // Neither a clear yes nor a clear no -- treat it as a new request and replace the
      // pending plan below rather than leaving a stale one a later "yes" could reattach to.
      req.session.pendingPlan = undefined;
    }

    const planned = await planChatTurn({ genai, models: MODELS, apiBase, apiKey, message });

    if (planned.kind === "clarified") {
      // No capability matched clearly enough to act on -- nothing was invoked. See
      // planner.ts's PlanResult for the real incident (a bare "hi" creating a member) this
      // closes; the model's own reply goes straight back, since there's no structured
      // result to template a deterministic one from.
      res.json({ reply: planned.message });
      return;
    }

    if (planned.capability.hasRiskyStep) {
      // Explicit user requirement: before doing anything that creates/changes something,
      // reconfirm the data with the human and only proceed after they say so -- so hold the
      // plan (with its REAL, unredacted params -- needed to actually invoke it once
      // confirmed) in the session instead of invoking it now.
      req.session.pendingPlan = planned;
      res.json({ reply: describePendingPlan(planned, new Set(Object.keys(fillParams))) });
      return;
    }

    // Read-only capabilities (e.g. check-balance) have nothing to confirm -- there's no
    // action to reconsider before it happens.
    const turn = await invokePlannedTurn({ apiBase, apiKey, fillParams }, planned);
    res.json(invokedTurnResponse(turn));
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
