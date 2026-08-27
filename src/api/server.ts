import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { findCapabilityById, loadCapabilityCatalog } from "../artifact/catalog.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { redact } from "../guardrails/redaction.js";
import { replay } from "../replay/replay-engine.js";
import { computeConfidence, getOrCreateEntry, loadRegistry, recordReplayOutcome, saveRegistry } from "../artifact/registry.js";
import { statusCodeFor } from "./status.js";
import { resolveEffectiveArtifact } from "./tenant-resolution.js";
import { driftAdjustedLabel } from "../replay/drift.js";
import { loadMatchingDriftReports } from "../replay/drift-loader.js";
import { effectiveAllowRisky } from "../replay/execution-policy.js";
import { requireApiKey } from "../http/api-key-auth.js";
import { requestLog } from "../http/request-log.js";
import { HttpEscalationRegistry } from "./http-escalation.js";

/**
 * The brief's §8 "agent-facing capability interface" stretch goal: a small HTTP surface an
 * AI agent could discover (`GET /capabilities`) and invoke by name with typed args
 * (`POST /capabilities/:id/invoke`) -- the literal seam Section 1 describes ("the
 * agent-facing product decides what to do; this system is how it reliably and safely does
 * it"). This is a thin wrapper: no new business logic. Every invocation runs through the
 * exact same `replay()` engine, `GuardrailsPolicy`, and confidence-registry gate as the
 * `replay` CLI -- an agent calling this can't get looser guardrails than a human running
 * the CLI would. A risky step on a non-approved artifact still declines automatically here
 * (no `onRiskyStep` callback is passed) rather than hanging the request on a prompt with no
 * terminal to answer it -- that pre-flight approval gate is deliberately unattended-only.
 *
 * A genuine mid-replay hard failure (§3.6's "escalate to a human") is a different case, and
 * DOES get a real human-in-the-loop path here: `onEscalate` is wired to a
 * `HttpEscalationRegistry` (`./http-escalation.ts`) instead of a terminal prompt, so a
 * console/dashboard user -- not someone at this process's stdin -- can see the paused run
 * (screenshot included, via `GET /interventions`) and resolve it (`POST
 * /interventions/:id/resolve`) while the original `/invoke` request stays open waiting. The
 * live, headed browser page itself is the same real handoff surface `EscalationController`
 * gives the CLI; this just answers "who resolves it" with an HTTP caller instead of stdin.
 * Requires a real API key (CAPABILITY_API_KEY -- see .env.example and SECURITY.md) on every
 * route except /health: this endpoint can both read capability confidence state and trigger
 * a real action, so both legs need the same gate, not just /invoke.
 */

// Configurable (mirrors CAPABILITY_API_PORT below), not just a literal, so a second instance
// of this exact server can run against a second, separate capability catalog -- e.g. one
// pointed at mock-bank's artifacts, another at a different target app's -- the same
// "same code, a second instance, separate config" pattern already used for the northgate-cu
// mock-bank tenant, one level up (a whole different target app, not just a rebrand).
const ARTIFACTS_DIR = process.env.CAPABILITY_ARTIFACTS_DIR ?? "evidence/artifacts";
const REGISTRY_PATH = path.join(ARTIFACTS_DIR, "registry.json");

// One shared instance for this process's lifetime -- every /invoke call that hits a genuine
// hard failure raises its escalation here, so a single console polling /interventions sees
// every pending one regardless of which invocation raised it.
const escalationRegistry = new HttpEscalationRegistry();

const app = express();
app.disable("x-powered-by");
// hsts: false -- this server is plain HTTP on localhost only, never TLS, in every context
// this repo runs in; helmet's default Strict-Transport-Security header is a promise it can't
// keep. A real bug, reproduced live in Safari/WebKit against src/chat-ui/server.ts (which
// serves the same header by default): the browser believed the header and upgraded later
// same-origin requests to https, which then failed outright with no TLS listener to answer.
app.use(helmet({ hsts: false }));
app.use(express.json());
app.use(requestLog("capability-api"));

// Unauthenticated on purpose -- container orchestrators and uptime checks need this to work
// without a credential, and it discloses nothing beyond "the process is up."
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(requireApiKey());

// Invocation can trigger a real (guardrail-checked) action against the target system --
// throttled independently of read traffic so a runaway/malicious caller can't exhaust the
// same budget a normal discovery (`GET /capabilities`) call would need.
const invokeLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

// The human-escalation surface (§3.6): what's paused right now, waiting for a person, and
// how a person resolves it. See http-escalation.ts's own doc comment for why this exists
// alongside (not instead of) EscalationController's terminal-prompt version.
app.get("/interventions", (_req, res) => {
  res.json(escalationRegistry.list());
});

// Path never comes from the request -- only from this process's own in-memory registry
// (populated by createOnEscalate, never by client input) -- so there's no path-traversal
// surface here despite serving a file by id.
app.get("/interventions/:id/screenshot", (req, res) => {
  const screenshotPath = escalationRegistry.getScreenshotPath(req.params.id);
  if (!screenshotPath || !fs.existsSync(screenshotPath)) {
    res.status(404).json({ error: `No pending intervention (or no screenshot) for id "${req.params.id}".` });
    return;
  }
  res.type("png").send(fs.readFileSync(screenshotPath));
});

app.post("/interventions/:id/resolve", (req, res) => {
  const decision = req.body?.decision === "resume" || req.body?.decision === "abort" ? req.body.decision : undefined;
  if (!decision) {
    res.status(400).json({ error: 'Missing or invalid "decision" -- must be "resume" or "abort".' });
    return;
  }
  const resolved = escalationRegistry.resolve(req.params.id, decision);
  if (!resolved) {
    res.status(404).json({ error: `No pending intervention with id "${req.params.id}" (already resolved, timed out, or never existed).` });
    return;
  }
  res.json({ resolved: true, decision });
});

app.get("/capabilities", (_req, res) => {
  const catalog = loadCapabilityCatalog(ARTIFACTS_DIR);
  res.json(
    catalog.map(({ artifact, fingerprint, approvalState, confidence }) => ({
      id: artifact.id,
      name: artifact.name,
      description: artifact.description,
      version: artifact.version,
      fingerprint,
      approvalState,
      confidence,
      inputParams: artifact.inputParams,
      outputSchema: artifact.outputSchema,
      // Lets a caller decide whether to confirm with a human before invoking, without
      // having to fetch the whole artifact just to inspect step-level risk itself -- the
      // chat UI's own pre-invoke confirmation step (see src/chat-ui/server.ts) is the real
      // reason this exists.
      hasRiskyStep: artifact.steps.some((s) => s.risk === "risky"),
    }))
  );
});

app.post("/capabilities/:id/invoke", invokeLimiter, async (req, res) => {
  const capability = findCapabilityById(req.params.id, ARTIFACTS_DIR);
  if (!capability) {
    res.status(404).json({ error: `No capability artifact found with id "${req.params.id}".` });
    return;
  }

  // Cross-tenant reuse (REPORT.md §8), reachable over HTTP: an agent can ask for a specific
  // tenant's variant of this capability, not just the base artifact. Resolved -- and any
  // bad tenantId rejected -- before a logger/browser/registry entry is ever created, same
  // as the capability-not-found check above.
  const tenantId = typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined;
  let artifact;
  try {
    artifact = resolveEffectiveArtifact(capability.artifact, tenantId);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const params = (req.body?.params ?? {}) as Record<string, string>;
  const requestedAllowRisky = req.body?.allowRisky === true;

  const runId = newRunId("replay");
  const logger = new EvidenceLogger({ runId, runType: "replay" });

  const sensitiveParamNames = artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name);
  logger.addSensitiveKeys(sensitiveParamNames);
  for (const name of sensitiveParamNames) {
    const value = params[name];
    if (value) logger.addSensitiveValue(value);
  }

  // A tenant override produces its own content fingerprint (steps/checkpoints differ from
  // the base artifact -- see registry.ts), so it earns its own draft/approved trust
  // independent of the base artifact's, exactly like the CLI/replay path.
  const registry = loadRegistry(REGISTRY_PATH);
  const entry = getOrCreateEntry(registry, artifact);
  const drift = loadMatchingDriftReports(artifact, entry.fingerprint, undefined, tenantId);
  const adjustedConfidenceLabel = driftAdjustedLabel(computeConfidence(entry).label, drift);
  // Same gate as the CLI (src/cli/replay.ts): --allow-risky/allowRisky only takes effect
  // once this exact artifact content -- base or tenant-overridden -- has been approved AND
  // its drift-adjusted confidence hasn't degraded to "low"/"unproven" (the circuit
  // breaker, src/replay/execution-policy.ts) -- an agent calling this over HTTP can't get
  // looser guardrails than a human running the CLI would.
  const allowRisky = effectiveAllowRisky({ requestedAllowRisky, approvalState: entry.approvalState, driftAdjustedLabel: adjustedConfidenceLabel });

  logger.log({
    step: 0,
    phase: "start",
    summary: `Capability API invoked ${artifact.name} v${artifact.version}`,
    detail: {
      operatorId: req.operatorId,
      fingerprint: entry.fingerprint,
      tenantId,
      approvalState: entry.approvalState,
      driftAdjustedConfidenceLabel: adjustedConfidenceLabel,
      allowRiskyRequested: requestedAllowRisky,
      allowRiskyEffective: allowRisky,
      params: redact(params, { sensitiveKeys: new Set(sensitiveParamNames) }),
    },
  });

  // Headed by default: an agent (or a chat message) invoking a capability should visibly
  // drive the same live browser a human running `replay` would watch -- the point of this
  // whole system is that a real UI actually gets clicked/typed through, not a black box
  // that just returns JSON. Deliberately configurable, not hardcoded either way: a genuinely
  // unattended, high-throughput caller (a scheduled canary check, a load test) has no one
  // watching and no reason to pay for a rendered window, so CAPABILITY_API_HEADED=false
  // opts back into the original headless behavior for exactly that case.
  const headed = process.env.CAPABILITY_API_HEADED !== "false";
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });
  try {
    await surface.launch("about:blank");
    const policy = new GuardrailsPolicy();

    const result = await replay({
      artifact,
      params,
      surface,
      policy,
      logger,
      runId,
      allowRisky,
      onEscalate: escalationRegistry.createOnEscalate({ page: surface.getPage(), logger, runId, capability: artifact.name }),
    });

    logger.writeJson("replay-result.json", result);

    recordReplayOutcome(entry, { runId, timestamp: new Date().toISOString(), status: result.status });
    saveRegistry(REGISTRY_PATH, registry);

    res.status(statusCodeFor(result)).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log({ step: 0, phase: "error", summary: `Capability API invocation error: ${message}` });
    const isParamValidationError = /^(Missing required input params|Invalid input params)/.test(message);
    res.status(isParamValidationError ? 400 : 500).json({ error: message });
  } finally {
    await surface.close();
  }
});

const PORT = Number(process.env.CAPABILITY_API_PORT ?? 4700);
app.listen(PORT, () => {
  console.log(`Capability API listening on http://localhost:${PORT}`);
});
