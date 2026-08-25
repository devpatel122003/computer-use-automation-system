import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { redact } from "../guardrails/redaction.js";
import { replay } from "../replay/replay-engine.js";
import { EscalationController } from "../escalation/controller.js";
import { parseArgs } from "./args.js";
import { computeConfidence, getOrCreateEntry, loadRegistry, recordReplayOutcome, saveRegistry } from "../artifact/registry.js";
import { applyTenantOverride, TenantOverrideSchema } from "../artifact/tenant-override.js";

const DEFAULT_REGISTRY_PATH = "evidence/artifacts/registry.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "evidence/artifacts/open-sub-account.artifact.json";
  const paramsJson = args.params ?? (args["params-file"] ? fs.readFileSync(args["params-file"], "utf-8") : "{}");
  const requestedAllowRisky = args["allow-risky"] === "true";
  const headed = args.headless !== "true";
  const registryPath = args.registry ?? DEFAULT_REGISTRY_PATH;

  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const baseArtifact = CapabilityArtifactSchema.parse(raw);
  const params = JSON.parse(paramsJson) as Record<string, string>;

  // Cross-tenant reuse (REPORT.md "Heterogeneity & multi-tenant"): the same recorded
  // artifact, adapted to a second tenant running the same underlying vendor product via a
  // small named patch instead of a re-recording. Applied before anything else touches the
  // artifact, so registry/confidence/replay all operate on the tenant-effective content.
  const tenantOverridePath = args["tenant-override"];
  let artifact = baseArtifact;
  let appliedTenantId: string | undefined;
  if (tenantOverridePath) {
    const overrideRaw = JSON.parse(fs.readFileSync(tenantOverridePath, "utf-8"));
    const override = TenantOverrideSchema.parse(overrideRaw);
    artifact = applyTenantOverride(baseArtifact, override);
    appliedTenantId = override.tenantId;
    console.log(`Applying tenant override "${override.tenantId}" from ${tenantOverridePath}`);
  }

  const registry = loadRegistry(registryPath);
  const entry = getOrCreateEntry(registry, artifact);
  const confidence = computeConfidence(entry);

  // Confidence & approval gate (Section 8 stretch goal): unattended replay of a risky step
  // is only honored for an *approved* artifact. A draft artifact always requires
  // interactive confirmation for risky steps, regardless of --allow-risky.
  const allowRisky = requestedAllowRisky && entry.approvalState === "approved";

  const runId = newRunId("replay");
  const logger = new EvidenceLogger({ runId, runType: "replay" });

  // Register sensitive param names/values on the logger -- and redact anything we print to
  // the terminal ourselves -- before the first console.log, not just before calling
  // replay(). Otherwise this CLI's own "Params: ..." line prints credentials in the clear
  // to stdout (and into shell history), even though the evidence files stay clean.
  const sensitiveParamNames = artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name);
  logger.addSensitiveKeys(sensitiveParamNames);
  for (const name of sensitiveParamNames) {
    const value = params[name];
    if (value) logger.addSensitiveValue(value);
  }
  const redactedParams = redact(params, { sensitiveKeys: new Set(sensitiveParamNames) });

  logger.log({
    step: 0,
    phase: "start",
    summary: `Replay CLI invoked for ${artifact.name} v${artifact.version}`,
    detail: {
      fingerprint: entry.fingerprint,
      approvalState: entry.approvalState,
      confidence,
      allowRiskyRequested: requestedAllowRisky,
      allowRiskyEffective: allowRisky,
      params: redactedParams,
      tenantOverride: tenantOverridePath ? { path: tenantOverridePath, tenantId: appliedTenantId } : undefined,
    },
  });

  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });
  try {
    // The artifact's own step-1 is always the recorded initial navigate; start blank and let it drive.
    await surface.launch("about:blank");

    const policy = new GuardrailsPolicy();
    const escalation = new EscalationController(surface.getPage(), logger, runId, "replay", artifact.name);

    console.log(`Replay run: ${runId}`);
    console.log(`Artifact: ${artifact.name} v${artifact.version} (${entry.fingerprint})${appliedTenantId ? ` [tenant override: ${appliedTenantId}]` : ""}`);
    console.log(
      `Approval: ${entry.approvalState} | Confidence: ${confidence.label} ` +
        `(${confidence.successCount}/${confidence.totalRuns} clean runs)`
    );
    if (requestedAllowRisky && !allowRisky) {
      console.log(
        "--allow-risky was requested but ignored: this artifact is still in draft state. " +
          `Run \`npm run approve -- --artifact ${artifactPath}\` first, or confirm interactively below.`
      );
    }
    console.log(`Params: ${JSON.stringify(redactedParams)}\n`);

    const result = await replay({
      artifact,
      params,
      surface,
      policy,
      logger,
      runId,
      allowRisky,
      onRiskyStep: async ({ step }) => escalation.confirmRiskyAction(`Step ${step.id}: ${step.description}`),
    });

    logger.writeJson("replay-result.json", result);
    recordReplayOutcome(entry, { runId, timestamp: new Date().toISOString(), status: result.status });
    saveRegistry(registryPath, registry);

    console.log(`\nReplay finished with status: ${result.status}`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`Evidence written to: ${logger.runDir}`);
    console.log(`Registry updated: ${path.resolve(registryPath)}`);

    process.exitCode = result.status === "failure" ? 1 : 0;
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
