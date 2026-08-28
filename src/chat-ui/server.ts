import "dotenv/config";
import fs from "node:fs";
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
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { DiscoveryAgent } from "../agent/discovery-agent.js";
import type { HttpMethod, RiskLevel, RouteRule } from "../guardrails/allowlist.js";

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
 *      (the active TARGETS entry's own `fillParams`, below) via runChatTurn's `fillParams`,
 *      which always wins over anything the model itself proposed. The customer's chat text
 *      is never trusted for a credential, mirroring exactly why planner.ts excludes
 *      sensitive params from its function-calling `required` list in the first place.
 *
 * This same server is also the "unified demo console" shell: /catalog and /config exist
 * only to feed the sidebar in public/index.html (capability list, demo-script buttons, an
 * optional dashboard link) so a live demo has one page to drive instead of three separate
 * ports. Neither route adds new business logic -- /catalog is a redacted read-through of
 * capability-api's own /capabilities, and a demo-script button just fills the existing chat
 * input and submits it through the unchanged /chat path above.
 *
 * One port, multiple targets: rather than running a separate chat-ui PROCESS per target
 * (the original mock-bank-only design, then a second `chat-ui-meridian` instance bolted on
 * for the adaptation), this single process holds a small TARGETS registry (which
 * capability-api instance, which fillParams identity, which demo scripts, which dashboard)
 * and a per-BROWSER-SESSION `activeTargetId` (POST /target) selects among them -- the same
 * "one process, session-scoped selection" shape express-session already uses for
 * pendingPlan/pendingChain, just applied to "which backend" instead of "which pending
 * action." Switching targets clears pendingPlan/pendingChain/history: a different target
 * means a different capability catalog and a different signed-on identity, so anything
 * pending against the OLD target is actively wrong against the new one, not just stale.
 */

const MODELS = resolveModelList();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unrelated to fillParams below: which named entry in config/operators.json this server's
// OWN outbound calls to any capability-api instance authenticate as. Falls back to
// CAPABILITY_API_KEY (resolving to "local-operator") when unset. Verified shared across
// instances: every capability-api process (mock-bank's on :4700, MERIDIAN's on :4701) loads
// the SAME config/operators.json and resolves the SAME env var, so one key here works
// against either -- this is what makes a single process safely multi-target in the first
// place, not an assumption.
const CAPABILITY_API_KEY = process.env.CHAT_UI_SERVICE_API_KEY ?? process.env.CAPABILITY_API_KEY;

interface TargetDefinition {
  id: string;
  label: string;
  apiBase: string;
  /** The operator identity this target's capabilities sign on as -- injected into every
   *  capability invocation via fillParams (see the header comment's item 2), always
   *  overwriting anything the model itself proposed. A customer's chat text is never
   *  trusted for a credential; which target is active decides which credential, not the
   *  user's own message. */
  fillParams: Record<string, string>;
  demoScriptsFile?: string;
  dashboardUrl?: string;
}

// Built-in default covering both targets this repo actually ships evidence for, at their
// standard documented ports (README's "MERIDIAN CORE adaptation demo path"). A third entry
// signs on as the MERIDIAN supervisor rather than the teller -- not a different backend, the
// same capability-api instance and catalog, just a different identity -- so a demo can show
// both sides of the Place Hold permission boundary (teller: supervisor_override_required;
// supervisor: succeeds) from the same console via the target switcher, without a fourth port.
const DEFAULT_TARGETS: TargetDefinition[] = [
  {
    id: "mock-bank",
    label: "Mock Bank",
    apiBase: "http://localhost:4700",
    fillParams: { username: "demo_operator", password: "demo_password" },
    demoScriptsFile: "config/demo-scripts/mock-bank.json",
    dashboardUrl: "http://localhost:4600",
  },
  {
    id: "meridian",
    label: "MERIDIAN CORE (teller)",
    apiBase: "http://localhost:4701",
    fillParams: { username: "teller1", password: "password", branch: "MAIN-001" },
    demoScriptsFile: "config/demo-scripts/meridian.json",
    dashboardUrl: "http://localhost:4601",
  },
  {
    id: "meridian-supervisor",
    label: "MERIDIAN CORE (supervisor)",
    apiBase: "http://localhost:4701",
    fillParams: { username: "super1", password: "password", branch: "MAIN-001" },
    demoScriptsFile: "config/demo-scripts/meridian-supervisor.json",
    dashboardUrl: "http://localhost:4601",
  },
];

/** Optional full override -- a JSON file shaped like DEFAULT_TARGETS above -- for anyone
 *  pointing this console at a different port layout or a third real target entirely.
 *  Falls back to DEFAULT_TARGETS (not an empty list) so this console is never target-less
 *  over a typo'd path or an unset env var. */
function loadTargets(): TargetDefinition[] {
  const filePath = process.env.CHAT_UI_TARGETS_FILE;
  if (!filePath) return DEFAULT_TARGETS;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Malformed/missing file -- fall back rather than crash a demo server over a typo'd path.
  }
  return DEFAULT_TARGETS;
}

export const TARGETS = loadTargets();
const TARGETS_BY_ID = new Map(TARGETS.map((t) => [t.id, t]));

/** Unknown/unset id (a fresh browser session that never called POST /target, or a stale id
 *  from before a targets-file edit) resolves to the first configured target rather than
 *  throwing -- same "never target-less" posture as loadTargets itself. */
export function resolveTarget(id: string | undefined): TargetDefinition {
  return (id && TARGETS_BY_ID.get(id)) || TARGETS[0];
}

function loadDemoScripts(filePath: string | undefined): Array<{ label: string; message: string }> {
  if (!filePath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Malformed/missing file -- an empty script list, not a crash; the chat panel itself
    // still works with no buttons.
  }
  return [];
}

interface RegisterTargetExample {
  label: string;
  baseUrl: string;
  startUrl: string;
  routesText: string;
  goal: string;
}

const REGISTER_TARGET_EXAMPLES_PATH = "config/register-target-examples.json";

/** Same config-file-not-hardcoded shape as loadDemoScripts/TARGETS above, applied to the
 *  "Register a new target" form: a picker of known-good examples (base URL, routes, goal)
 *  a presenter can select instead of typing live, with zero change to what
 *  POST /register-target itself does -- this only pre-fills the same four fields a person
 *  would otherwise type by hand. Adding a new example later (a different fixture, a
 *  different goal against the same one) is a JSON edit, not a code change. */
export function loadRegisterTargetExamples(): RegisterTargetExample[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTER_TARGET_EXAMPLES_PATH, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Malformed/missing file -- no examples in the picker, not a crash; the form itself
    // still works exactly as it did before this existed.
  }
  return [];
}

// Holds a planned-but-not-yet-invoked risky capability call across exactly one confirmation
// round-trip -- see the /chat handler below. A memory-backed session (express-session's
// default store, same posture as mock-bank's own login session) is enough for a demo: this
// is a single process, and losing a pending plan on restart just means re-asking the
// question, not a correctness problem.
declare module "express-session" {
  interface SessionData {
    /** Which TARGETS entry this browser session is currently talking to. Unset until the
     *  first POST /target -- resolveTarget(undefined) falls back to TARGETS[0], so a fresh
     *  session works with no explicit selection. */
    activeTargetId?: string;
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

// Static, local config the browser needs to render the console shell (the active target,
// the full target list for the switcher, which demo-script buttons to show, whether an ops
// dashboard link exists). No secrets here -- same posture as /health, deliberately
// unauthenticated and unlimited.
app.get("/config", (req, res) => {
  const target = resolveTarget(req.session.activeTargetId);
  res.json({
    activeTarget: { id: target.id, label: target.label },
    targets: TARGETS.map((t) => ({ id: t.id, label: t.label })),
    dashboardUrl: target.dashboardUrl ?? null,
    demoScripts: loadDemoScripts(target.demoScriptsFile),
    registerTargetExamples: loadRegisterTargetExamples(),
  });
});

// Switches which TARGETS entry this browser session talks to. A GET-based design (e.g.
// `?target=meridian`) would let a stray link or a bookmarked URL silently switch a live
// session's backend/identity; a POST keeps that an explicit action.
app.post("/target", (req, res) => {
  const targetId = typeof req.body?.targetId === "string" ? req.body.targetId : undefined;
  const target = targetId ? TARGETS_BY_ID.get(targetId) : undefined;
  if (!target) {
    res.status(400).json({ error: `Unknown target "${targetId}". Valid targets: ${TARGETS.map((t) => t.id).join(", ")}` });
    return;
  }
  req.session.activeTargetId = target.id;
  // See the file header comment: a different target means a different capability catalog
  // and a different signed-on identity, so anything pending against the OLD target is
  // actively wrong against the new one, not just stale.
  req.session.pendingPlan = undefined;
  req.session.pendingChain = undefined;
  req.session.history = undefined;
  res.json({ activeTarget: { id: target.id, label: target.label } });
});

// Read-only proxy for the console's capability-catalog sidebar. Holds CAPABILITY_API_KEY
// server-side and forwards it -- the browser never sees a key of its own, same boundary
// /chat already relies on for invocations. GET-only and just a pass-through of
// capability-api's own /capabilities (itself already redacted/non-sensitive metadata), so
// this doesn't need the rate limiter guarding /chat's real invocations.
app.get("/catalog", async (req, res) => {
  const target = resolveTarget(req.session.activeTargetId);
  if (!CAPABILITY_API_KEY) {
    res.status(500).json({ error: "Server is not configured (missing CHAT_UI_SERVICE_API_KEY or CAPABILITY_API_KEY)." });
    return;
  }
  try {
    const listRes = await fetch(`${target.apiBase}/capabilities`, { headers: { Authorization: `Bearer ${CAPABILITY_API_KEY}` } });
    if (!listRes.ok) {
      res.status(502).json({ error: `GET /capabilities failed: HTTP ${listRes.status}` });
      return;
    }
    res.json(await listRes.json());
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Couldn't reach the capability API at ${target.apiBase}: ${messageText}` });
  }
});

// Human-escalation proxy, same pattern as /catalog: the browser polls this instead of
// holding a capability-api key of its own. Scoped to the ACTIVE target -- an escalation
// raised by one target's capability-api instance is only visible while that target is
// selected, since it's genuinely a different process with its own in-memory registry (see
// http-escalation.ts). Read-only and cheap enough to poll every couple of seconds.
app.get("/interventions", async (req, res) => {
  const target = resolveTarget(req.session.activeTargetId);
  if (!CAPABILITY_API_KEY) {
    res.status(500).json({ error: "Server is not configured (missing CHAT_UI_SERVICE_API_KEY or CAPABILITY_API_KEY)." });
    return;
  }
  try {
    const listRes = await fetch(`${target.apiBase}/interventions`, { headers: { Authorization: `Bearer ${CAPABILITY_API_KEY}` } });
    if (!listRes.ok) {
      res.status(502).json({ error: `GET /interventions failed: HTTP ${listRes.status}` });
      return;
    }
    res.json(await listRes.json());
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Couldn't reach the capability API at ${target.apiBase}: ${messageText}` });
  }
});

app.get("/interventions/:id/screenshot", async (req, res) => {
  const target = resolveTarget(req.session.activeTargetId);
  try {
    const imgRes = await fetch(`${target.apiBase}/interventions/${req.params.id}/screenshot`, {
      headers: { Authorization: `Bearer ${CAPABILITY_API_KEY ?? ""}` },
    });
    if (!imgRes.ok) {
      res.status(imgRes.status).end();
      return;
    }
    res.type("png").send(Buffer.from(await imgRes.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// The one write route in this proxy group -- a human clicking Resume/Abort in the console.
// No new rate limiter: this can only ever act on an intervention that already exists (a
// stray or repeated call just gets a 404 from capability-api, same as any other bad id), so
// it carries none of /chat's "can trigger a fresh real action" risk.
app.post("/interventions/:id/resolve", async (req, res) => {
  const target = resolveTarget(req.session.activeTargetId);
  const decision = req.body?.decision;
  try {
    const resolveRes = await fetch(`${target.apiBase}/interventions/${req.params.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CAPABILITY_API_KEY ?? ""}` },
      body: JSON.stringify({ decision }),
    });
    const data = await resolveRes.json().catch(() => ({}));
    res.status(resolveRes.status).json(data);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Couldn't reach the capability API at ${target.apiBase}: ${messageText}` });
  }
});

/**
 * "A new bank's UI shows up -- where's the option to add it?" This is that option: a
 * console-reachable form that (1) adds the new target's base URL and the routes it's
 * expected to use to config/allowlist.json for real, then (2) runs one genuine
 * LLM-driven discovery run against it -- the actual first half of onboarding a new target
 * (brief §3.7/§8's "generalization" story), not a mock of it.
 *
 * Deliberately does NOT also produce a finished, reusable capability artifact -- that would
 * mean inventing automatic inference for paramMappings/successCheckpoint/knownOutcomes,
 * exactly the thing this repo has consistently kept human-authored on purpose (see
 * recorder.ts's own doc comment). What this DOES prove for real: the agent can drive a
 * brand-new UI it has never seen, under the exact same guardrails as every other target,
 * with the allowlist entries it needed added through the console instead of by hand-editing
 * a JSON file. Turning a successful run into a capability is the next, still-manual step --
 * `npm run record-capability` (see README's "Recording a new capability" section), pointed
 * at this run's own evidence.
 *
 * Risky actions and mid-run escalations are auto-declined/aborted here rather than routed to
 * the console's interventions card: that mechanism (http-escalation.ts) is bound to a
 * REPLAY's `onEscalate` contract (keyed on an ArtifactStep), and discovery's shape is
 * different enough (no artifact exists yet) that reusing it would mean bolting on a second,
 * subtly different contract under time pressure. A read-only reconnaissance goal (sign on,
 * look something up) never hits this path at all; a goal needing confirmation or recovery
 * should go through the CLI's `run-agent`/`--interactive-escalation` tooling, which already
 * has a real answer for both.
 */
export function parseRouteLines(text: string): { routes: RouteRule[]; errors: string[] } {
  const routes: RouteRule[] = [];
  const errors: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const method = parts[0]?.toUpperCase();
    const pattern = parts[1];
    const riskWord = parts[2]?.toLowerCase();
    if (method !== "GET" && method !== "POST") {
      errors.push(`"${line}": expected the line to start with GET or POST.`);
      continue;
    }
    if (!pattern || !pattern.startsWith("/")) {
      errors.push(`"${line}": route pattern must start with "/" (e.g. /members/:id).`);
      continue;
    }
    // Same convention config/allowlist.json already uses throughout: a bare GET defaults
    // safe, a bare POST defaults risky, unless the line says otherwise -- reads/writes are
    // just as likely to be right by default as not, so this is a starting point to review,
    // not a substitute for actually looking at what each route does.
    const risk: RiskLevel = riskWord === "safe" || riskWord === "risky" ? riskWord : method === "GET" ? "safe" : "risky";
    routes.push({ pattern, methods: [method as HttpMethod], risk });
  }
  return { routes, errors };
}

const ALLOWLIST_PATH = "config/allowlist.json";

app.post("/register-target", async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: "Server is not configured (missing GEMINI_API_KEY)." });
    return;
  }
  const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  const routesText = typeof req.body?.routesText === "string" ? req.body.routesText : "";
  const startUrl = typeof req.body?.startUrl === "string" && req.body.startUrl.trim() ? req.body.startUrl.trim() : baseUrl;

  if (!baseUrl || !goal) {
    res.status(400).json({ error: 'Both "baseUrl" and "goal" are required.' });
    return;
  }
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    res.status(400).json({ error: `"${baseUrl}" isn't a valid URL.` });
    return;
  }

  const { routes, errors: routeErrors } = parseRouteLines(routesText);
  if (routes.length === 0) {
    res.status(400).json({
      error: "No valid routes parsed. Each line should look like: GET /login  or  POST /members/:id/transfer risky",
      details: routeErrors,
    });
    return;
  }

  // Persisted to disk BEFORE launching discovery -- GuardrailsPolicy re-reads this file from
  // scratch on every construction (no cache), so a policy built after this write sees the
  // new target immediately, in this same request, exactly like a human editing the file by
  // hand would need to before running discovery themselves.
  const allowlistConfig = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf-8")) as {
    allowedBaseUrls: string[];
    routes: RouteRule[];
  };
  if (!allowlistConfig.allowedBaseUrls.includes(parsedBase.origin)) {
    allowlistConfig.allowedBaseUrls.push(parsedBase.origin);
  }
  let routesAdded = 0;
  for (const route of routes) {
    const alreadyPresent = allowlistConfig.routes.some(
      (existing) => existing.pattern === route.pattern && existing.methods.includes(route.methods[0])
    );
    if (!alreadyPresent) {
      allowlistConfig.routes.push(route);
      routesAdded += 1;
    }
  }
  fs.writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlistConfig, null, 2)}\n`);

  const runId = newRunId("discovery");
  const logger = new EvidenceLogger({ runId, runType: "discovery" });
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed: process.env.CHAT_UI_DISCOVERY_HEADED !== "false" });
  try {
    await surface.launch(startUrl);
    const policy = new GuardrailsPolicy(); // fresh read of the allowlist just written above
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const agent = new DiscoveryAgent({
      surface,
      policy,
      logger,
      genai,
      onRiskyAction: async () => false,
      onEscalate: async () => "abort",
    });

    const result = await agent.run(goal, startUrl);
    logger.writeJson("discovery-result.json", result);

    res.json({
      runId,
      status: result.status,
      finalSummary: result.finalSummary,
      escalationReason: result.escalationReason,
      outputs: result.outputs,
      stepCount: result.steps.length,
      routesAddedToAllowlist: routesAdded,
      routeParseWarnings: routeErrors,
      evidenceDir: logger.runDir,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Discovery failed to run: ${message}` });
  } finally {
    await surface.close();
  }
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
    const target = resolveTarget(req.session.activeTargetId);
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const apiBase = target.apiBase;
    const apiKey = CAPABILITY_API_KEY;
    const fillParams = target.fillParams;
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
    // Re-resolved rather than reused from the try block above -- `target` there is scoped to
    // that block, and this catch can be reached before it's assigned (e.g. GEMINI_API_KEY
    // check aside, a throw from resolveTarget itself never happens, but keeping this
    // independent avoids relying on try-block variable lifetime across a catch boundary).
    const target = resolveTarget(req.session.activeTargetId);
    res.status(502).json({ error: `Couldn't reach the capability API at ${target.apiBase}: ${messageText}${hint}` });
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
