import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import { GoogleGenAI } from "@google/genai";
import { planChatTurn, invokePlannedTurn, type PlanChatTurnResult } from "../frontend/chat-turn.js";
import type { ConversationTurn } from "../frontend/planner.js";
import { planChainedTurn, type ChainPlanResult } from "../frontend/chain.js";
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
// A third sign-on field, needed by MERIDIAN CORE's capabilities (operator/password/branch)
// but not mock-bank's (operator/password only). Included in fillParams unconditionally --
// validateParams (src/replay/replay-engine.ts) only checks params a capability actually
// DECLARES as required, so an unused "branch" key is harmlessly ignored by any mock-bank
// capability that doesn't have one.
const OPERATOR_BRANCH = process.env.CHAT_UI_OPERATOR_BRANCH ?? "MAIN-001";

// Unrelated to the above: CHAT_UI_OPERATOR_USERNAME/PASSWORD is the mock-bank sign-on
// credential injected into capability params (see the header comment's item 2). This is a
// different concept -- which named entry in config/operators.json this server's OWN
// outbound call to the capability API authenticates as. Falls back to CAPABILITY_API_KEY
// (resolving to "local-operator") when unset, so a solo dev's setup needs no extra config;
// setting it lets every chat-UI-originated run's evidence/audit trail say "chat-ui-service"
// instead of whichever human happens to own the shared key.
const CAPABILITY_API_KEY = process.env.CHAT_UI_SERVICE_API_KEY ?? process.env.CAPABILITY_API_KEY;

// Holds a planned-but-not-yet-invoked risky capability call across exactly one confirmation
// round-trip -- see the /chat handler below. A memory-backed session (express-session's
// default store, same posture as mock-bank's own login session) is enough for a demo: this
// is a single process, and losing a pending plan on restart just means re-asking the
// question, not a correctness problem.
declare module "express-session" {
  interface SessionData {
    pendingPlan?: Extract<PlanChatTurnResult, { kind: "planned" }>;
    /** Independent of `pendingPlan` above -- a two-step chained request (see
     *  src/frontend/chain.ts) awaiting one combined "yes"/"no" before either step is
     *  actually invoked. Never set at the same time as `pendingPlan`; a turn produces at
     *  most one of the two. */
    pendingChain?: Extract<ChainPlanResult, { kind: "chained" }>;
    /** Prior exchanges in this browser session, oldest first -- see `ConversationTurn`'s
     *  doc comment in planner.ts for the real bug (multi-turn slot-filling silently losing
     *  context) this exists to fix. Capped below so a long-running chat can't grow this
     *  (and therefore every future model call's token cost) without bound. */
    history?: ConversationTurn[];
  }
}

// 10 exchanges (20 turns) is plenty of context for this demo's short slot-filling
// back-and-forths without letting a long session's token cost grow unbounded.
const MAX_HISTORY_TURNS = 20;

const app = express();
app.disable("x-powered-by");
// hsts: false -- a real bug, reproduced with Playwright's WebKit (Safari's engine): helmet's
// default Strict-Transport-Security header is a promise this server can never keep (it's
// plain HTTP on localhost, never TLS, in every context this repo runs in), and Safari
// believed it anyway -- upgrading the NEXT requests for style.css/chat.js on this origin to
// https://localhost:4800/..., which fails outright since nothing is listening for TLS there.
// The initial page load looked fine (it was already in flight before the header landed);
// only the same-origin sub-resource fetches right after it broke, which is exactly "no CSS,
// everything else looks fine" as reported live.
app.use(helmet({ hsts: false }));
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
    // Plain quoting, not markdown "**bold**" -- the chat page renders bot text with
    // `textContent` (chat.js), deliberately, since a bot reply can carry text that
    // ultimately traces back to a customer's own message or the model's own guess at a
    // field value; asterisks meant as bold just showed up literally in the bubble (a real
    // bug caught live).
    `Before I go ahead: I'm about to run "${planned.plan.capabilityId}"${tenantNote}` +
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

function describePendingChain(chain: Extract<ChainPlanResult, { kind: "chained" }>, hiddenParamNames: Set<string>): string {
  const describeStep = (planned: Extract<PlanChatTurnResult, { kind: "planned" }>, extraHidden: Set<string> = new Set()) => {
    const paramList = Object.entries(planned.redactedParams)
      .filter(([k]) => !hiddenParamNames.has(k) && !extraHidden.has(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return `"${planned.plan.capabilityId}"` + (paramList ? ` with ${paramList}` : "");
  };
  // Step 2's `mapping.toField` holds a placeholder value at this point (see chain.ts's own
  // MEMBER_ID_PLACEHOLDER_HINT) -- the real value doesn't exist yet, since step 1 hasn't
  // actually run. Showing a placeholder as if it were a real value to confirm is exactly
  // the "username: " blank-value confirmation bug from earlier in this project, just with a
  // non-empty placeholder instead of an empty string -- same fix, hide it from display.
  return (
    `Before I go ahead: I'm about to (1) run ${describeStep(chain.step1)}; then (2) run ${describeStep(chain.step2, new Set([chain.mapping.toField]))}, ` +
    `using the result from step 1. Reply "yes" to confirm both or "no" to cancel.`
  );
}

/** Exported (rather than an inline route callback) so it's directly unit-testable with a
 *  fake req/res, the same style src/http/api-key-auth.test.ts already uses for Express
 *  middleware -- no new test dependency (e.g. supertest) needed for what is, underneath
 *  the HTTP framing, a deterministic session state machine. */
export async function handleChat(req: express.Request, res: express.Response): Promise<void> {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing 'message'." });
    return;
  }
  if (!process.env.GEMINI_API_KEY || !CAPABILITY_API_KEY) {
    res.status(500).json({ error: "Server is not configured (missing GEMINI_API_KEY, and neither CHAT_UI_SERVICE_API_KEY nor CAPABILITY_API_KEY is set)." });
    return;
  }

  // Records this exchange in the session's conversation history (trimmed to the most
  // recent MAX_HISTORY_TURNS) and sends the JSON reply -- every response path below goes
  // through this so a follow-up message always has the context of what was actually said,
  // not just the isolated sentence it contains. `replyText` is deliberately whatever's
  // shown to the human, not the raw structured result -- that's what a real follow-up
  // ("about the account I just made...") would actually be referring back to.
  function respond(replyText: string, body: Record<string, unknown>) {
    const history = req.session.history ?? [];
    history.push({ role: "user", text: message }, { role: "model", text: replyText });
    req.session.history = history.slice(-MAX_HISTORY_TURNS);
    res.json({ reply: replyText, ...body });
  }

  try {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const apiBase = process.env.CAPABILITY_API_BASE ?? "http://localhost:4700";
    const apiKey = CAPABILITY_API_KEY;
    const fillParams = { username: OPERATOR_USERNAME, password: OPERATOR_PASSWORD, branch: OPERATOR_BRANCH };
    const history = req.session.history ?? [];

    // Checked FIRST, before the single-plan branch below: a pending CHAIN from a previous
    // turn takes priority over everything else, for the same reason a pending single plan
    // does -- this message's only job right now is to confirm, cancel, or (by saying
    // something else) supersede it.
    const pendingChain = req.session.pendingChain;
    if (pendingChain) {
      if (AFFIRMATIVE_RE.test(message)) {
        req.session.pendingChain = undefined;

        const step1Turn = await invokePlannedTurn({ apiBase, apiKey, fillParams }, pendingChain.step1);
        // Fail fast: never invoke step 2 if step 1 didn't cleanly succeed (covers both a
        // hard `failure` and an unexpected `business_outcome`) -- a broken first step has
        // nothing real to hand to the second one, and inventing a value to continue anyway
        // is exactly the failure mode this whole feature exists to avoid.
        if (step1Turn.httpStatus >= 400 || step1Turn.result.status !== "success") {
          respond(`${step1Turn.summary} I stopped here and didn't continue to the next step, since this one didn't succeed.`, { step1: invokedTurnResponse(step1Turn) });
          return;
        }

        const chainedValue = step1Turn.result.outputs?.[pendingChain.mapping.fromField];
        if (!chainedValue) {
          respond(`${step1Turn.summary} I stopped here -- the result didn't include what I needed to continue to the next step.`, { step1: invokedTurnResponse(step1Turn) });
          return;
        }

        // Splices step 1's REAL output into step 2's params, unconditionally overwriting
        // anything the model itself proposed for that field when step 2 was planned in
        // isolation (it had no way to know the real value yet).
        const step2Planned: Extract<PlanChatTurnResult, { kind: "planned" }> = {
          ...pendingChain.step2,
          plan: { ...pendingChain.step2.plan, params: { ...pendingChain.step2.plan.params, [pendingChain.mapping.toField]: chainedValue } },
        };
        const step2Turn = await invokePlannedTurn({ apiBase, apiKey, fillParams }, step2Planned);

        respond(`${step1Turn.summary} Then, ${step2Turn.summary}`, { step1: invokedTurnResponse(step1Turn), step2: invokedTurnResponse(step2Turn) });
        return;
      }
      if (NEGATIVE_RE.test(message)) {
        req.session.pendingChain = undefined;
        respond("Okay, I won't go ahead with either step.", {});
        return;
      }
      // Neither a clear yes nor a clear no -- same "supersede" rule the single-plan branch
      // uses: discard the stale chain rather than leaving it for a later, unrelated "yes"
      // to accidentally confirm.
      req.session.pendingChain = undefined;
    }

    // A pending risky plan from a PREVIOUS turn takes priority over re-planning this
    // message from scratch: this message's only job right now is to confirm, cancel, or
    // (implicitly, by saying something else entirely) supersede that plan.
    const pending = req.session.pendingPlan;
    if (pending) {
      if (AFFIRMATIVE_RE.test(message)) {
        req.session.pendingPlan = undefined;
        const turn = await invokePlannedTurn({ apiBase, apiKey, fillParams }, pending);
        const { reply, ...body } = invokedTurnResponse(turn);
        respond(reply, body);
        return;
      }
      if (NEGATIVE_RE.test(message)) {
        req.session.pendingPlan = undefined;
        respond("Okay, I won't go ahead with that. Let me know if there's something else I can help with.", {});
        return;
      }
      // Neither a clear yes nor a clear no -- treat it as a new request and replace the
      // pending plan below rather than leaving a stale one a later "yes" could reattach to.
      req.session.pendingPlan = undefined;
    }

    // Chain detection is a pure text split (see chain.ts) -- cheap, deterministic, and
    // always safe to fall back from ("not-chain") into the existing single-plan path below
    // if the message doesn't split, either half doesn't plan cleanly, or the two chosen
    // capabilities have no verified output->input relationship in CHAIN_MAPPINGS.
    const chainPlan = await planChainedTurn({ genai, models: MODELS, apiBase, apiKey, fillParams }, message, history);
    if (chainPlan.kind === "chained") {
      // Every real "from" capability in CHAIN_MAPPINGS (create-member) is risky in this
      // catalog, so a chain is always confirmed -- no "auto-invoke, nothing risky" branch
      // exists here, since there's no real data to trigger it with today.
      req.session.pendingChain = chainPlan;
      respond(describePendingChain(chainPlan, new Set(Object.keys(fillParams))), {});
      return;
    }

    const planned = await planChatTurn({ genai, models: MODELS, apiBase, apiKey, message, history, fillParams });

    if (planned.kind === "clarified") {
      // No capability matched clearly enough to act on -- nothing was invoked. See
      // planner.ts's PlanResult for the real incident (a bare "hi" creating a member) this
      // closes; the model's own reply goes straight back, since there's no structured
      // result to template a deterministic one from.
      respond(planned.message, {});
      return;
    }

    if (planned.capability.hasRiskyStep) {
      // Explicit user requirement: before doing anything that creates/changes something,
      // reconfirm the data with the human and only proceed after they say so -- so hold the
      // plan (with its REAL, unredacted params -- needed to actually invoke it once
      // confirmed) in the session instead of invoking it now.
      req.session.pendingPlan = planned;
      respond(describePendingPlan(planned, new Set(Object.keys(fillParams))), {});
      return;
    }

    // Read-only capabilities (e.g. check-balance) have nothing to confirm -- there's no
    // action to reconsider before it happens.
    const turn = await invokePlannedTurn({ apiBase, apiKey, fillParams }, planned);
    const { reply, ...body } = invokedTurnResponse(turn);
    respond(reply, body);
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
}

app.post("/chat", chatLimiter, handleChat);

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.CHAT_UI_PORT ?? 4800);
// Guarded so importing this module from a test (server.test.ts, which calls handleChat
// directly with fake req/res rather than going over real HTTP) doesn't also bind a real
// port. Vitest sets process.env.VITEST itself -- documented, standard behavior, not a
// convention this repo invented.
if (!process.env.VITEST) {
  app.listen(PORT, () => {
    console.log(`Chat UI listening on http://localhost:${PORT}`);
  });
}
