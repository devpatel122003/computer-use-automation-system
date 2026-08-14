import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { replay } from "../replay/replay-engine.js";
import { EscalationController } from "../escalation/controller.js";
import { parseArgs } from "./args.js";
import { computeConfidence, getOrCreateEntry, loadRegistry, recordReplayOutcome, saveRegistry } from "../artifact/registry.js";

const DEFAULT_REGISTRY_PATH = "evidence/artifacts/registry.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "evidence/artifacts/open-sub-account.artifact.json";
  const paramsJson = args.params ?? (args["params-file"] ? fs.readFileSync(args["params-file"], "utf-8") : "{}");
  const requestedAllowRisky = args["allow-risky"] === "true";
  const headed = args.headless !== "true";
  const registryPath = args.registry ?? DEFAULT_REGISTRY_PATH;

  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const artifact = CapabilityArtifactSchema.parse(raw);
  const params = JSON.parse(paramsJson) as Record<string, string>;

  const registry = loadRegistry(registryPath);
  const entry = getOrCreateEntry(registry, artifact);
  const confidence = computeConfidence(entry);

  // Confidence & approval gate (Section 8 stretch goal): unattended replay of a risky step
  // is only honored for an *approved* artifact. A draft artifact always requires
  // interactive confirmation for risky steps, regardless of --allow-risky.
  const allowRisky = requestedAllowRisky && entry.approvalState === "approved";

  const runId = newRunId("replay");
  const logger = new EvidenceLogger({ runId, runType: "replay" });
  // The artifact's own step-1 is always the recorded initial navigate; start blank and let it drive.
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });
  await surface.launch("about:blank");

  const policy = new GuardrailsPolicy();
  const escalation = new EscalationController(surface.getPage(), logger, runId, "replay", artifact.name);

  console.log(`Replay run: ${runId}`);
  console.log(`Artifact: ${artifact.name} v${artifact.version} (${entry.fingerprint})`);
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
  console.log(`Params: ${JSON.stringify(params)}\n`);

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

  await surface.close();
  process.exit(result.status === "failure" ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
