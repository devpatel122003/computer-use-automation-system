import "dotenv/config";
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

/**
 * The brief's §8 "agent-facing capability interface" stretch goal: a small HTTP surface an
 * AI agent could discover (`GET /capabilities`) and invoke by name with typed args
 * (`POST /capabilities/:id/invoke`) -- the literal seam Section 1 describes ("the
 * agent-facing product decides what to do; this system is how it reliably and safely does
 * it"). This is a thin wrapper: no new business logic. Every invocation runs through the
 * exact same `replay()` engine, `GuardrailsPolicy`, and confidence-registry gate as the
 * `replay` CLI -- an agent calling this can't get looser guardrails than a human running
 * the CLI would. Unlike the CLI, there is no operator to prompt for a risky-step
 * confirmation, so a risky step on a non-`approved` artifact is declined automatically
 * (no `onRiskyStep` callback is passed) rather than hanging the request on stdin that will
 * never arrive. Requires a real API key (CAPABILITY_API_KEY -- see .env.example and
 * SECURITY.md) on every route except /health: this endpoint can both read capability
 * confidence state and trigger a real action, so both legs need the same gate, not just
 * /invoke.
 */

const ARTIFACTS_DIR = "evidence/artifacts";
const REGISTRY_PATH = "evidence/artifacts/registry.json";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json());
app.use(requestLog("capability-api"));

// Unauthenticated on purpose -- container orchestrators and uptime checks need this to work
// without a credential, and it discloses nothing beyond "the process is up."
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(requireApiKey("CAPABILITY_API_KEY"));

// Invocation can trigger a real (guardrail-checked) action against the target system --
// throttled independently of read traffic so a runaway/malicious caller can't exhaust the
// same budget a normal discovery (`GET /capabilities`) call would need.
const invokeLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

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
      fingerprint: entry.fingerprint,
      tenantId,
      approvalState: entry.approvalState,
      driftAdjustedConfidenceLabel: adjustedConfidenceLabel,
      allowRiskyRequested: requestedAllowRisky,
      allowRiskyEffective: allowRisky,
      params: redact(params, { sensitiveKeys: new Set(sensitiveParamNames) }),
    },
  });

  // Headless: this path stands in for an unattended agent calling into production, not a
  // human watching a demo window (contrast with run-agent/replay's default headed mode).
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed: false });
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
