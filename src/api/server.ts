import "dotenv/config";
import express from "express";
import { findCapabilityById, loadCapabilityCatalog } from "../artifact/catalog.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { redact } from "../guardrails/redaction.js";
import { replay } from "../replay/replay-engine.js";
import { getOrCreateEntry, loadRegistry, recordReplayOutcome, saveRegistry } from "../artifact/registry.js";
import { statusCodeFor } from "./status.js";

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
 * never arrive. No auth -- fine for a local demo, not for a real deployment (see README).
 */

const ARTIFACTS_DIR = "evidence/artifacts";
const REGISTRY_PATH = "evidence/artifacts/registry.json";

const app = express();
app.use(express.json());

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

app.post("/capabilities/:id/invoke", async (req, res) => {
  const capability = findCapabilityById(req.params.id, ARTIFACTS_DIR);
  if (!capability) {
    res.status(404).json({ error: `No capability artifact found with id "${req.params.id}".` });
    return;
  }

  const params = (req.body?.params ?? {}) as Record<string, string>;
  const requestedAllowRisky = req.body?.allowRisky === true;
  // Same gate as the CLI (src/cli/replay.ts): --allow-risky/allowRisky only takes effect
  // once this exact artifact content has been reviewed and approved.
  const allowRisky = requestedAllowRisky && capability.approvalState === "approved";

  const runId = newRunId("replay");
  const logger = new EvidenceLogger({ runId, runType: "replay" });

  const sensitiveParamNames = capability.artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name);
  logger.addSensitiveKeys(sensitiveParamNames);
  for (const name of sensitiveParamNames) {
    const value = params[name];
    if (value) logger.addSensitiveValue(value);
  }

  logger.log({
    step: 0,
    phase: "start",
    summary: `Capability API invoked ${capability.artifact.name} v${capability.artifact.version}`,
    detail: {
      fingerprint: capability.fingerprint,
      approvalState: capability.approvalState,
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
      artifact: capability.artifact,
      params,
      surface,
      policy,
      logger,
      runId,
      allowRisky,
    });

    logger.writeJson("replay-result.json", result);

    const registry = loadRegistry(REGISTRY_PATH);
    const entry = getOrCreateEntry(registry, capability.artifact);
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
