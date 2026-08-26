import "dotenv/config";
import fs from "node:fs";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { replay } from "../replay/replay-engine.js";
import { computeConfidence, getOrCreateEntry, loadRegistry, recordReplayOutcome, saveRegistry } from "../artifact/registry.js";
import { computeStabilitySignal } from "../artifact/stability.js";
import { appendCanaryRecord, computeCanaryTrend, loadCanaryHistory } from "../artifact/canary-history.js";
import { driftAdjustedLabel } from "../replay/drift.js";
import { loadMatchingDriftReports } from "../replay/drift-loader.js";
import { effectiveAllowRisky } from "../replay/execution-policy.js";
import { parseArgs } from "./args.js";

/**
 * Brief §8 "Multi-run stability": one real, unattended health check, meant to be invoked
 * on a schedule (a real crontab entry -- "every 15 minutes, cd /path && npm run
 * canary-check" -- deliberately not building the scheduler itself, per the brief's own
 * "don't build scaling infrastructure you don't need"; the SCRIPT is real, the cron wiring
 * is a one-line operational detail left to whoever deploys this). Every invocation is a genuine replay
 * through the exact same engine/guardrails/circuit-breaker as any other caller -- a canary
 * that could bypass the trust gates to "just check health" would be checking a different,
 * looser system than the one actually in production. Exit code reflects health: 0 = healthy,
 * 1 = flaky/unhealthy this run, 3 = REGRESSING (this scheduled check's own last several
 * invocations have been unhealthy in a row -- see canary-history.ts), 2 = uncaught error
 * (reserved, unrelated to health -- the outer `main().catch()` below).
 */

const DEFAULT_REGISTRY_PATH = "evidence/artifacts/registry.json";
const DEFAULT_CANARY_HISTORY_PATH = "evidence/canary-history.jsonl";
const DEFAULT_PARAMS = { username: "demo_operator", password: "demo_password", memberId: "10001", accountType: "Savings", initialDeposit: "100" };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "evidence/artifacts/open-sub-account.artifact.json";
  const paramsJson = args.params ?? JSON.stringify(DEFAULT_PARAMS);
  const registryPath = args.registry ?? DEFAULT_REGISTRY_PATH;
  const canaryHistoryPath = args["canary-history"] ?? DEFAULT_CANARY_HISTORY_PATH;
  const windowSize = args.window ? Number(args.window) : 5;
  const headed = args.headless === "true" ? false : args.headed === "true";

  const artifact = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(artifactPath, "utf-8")));
  const params = JSON.parse(paramsJson) as Record<string, string>;

  const registry = loadRegistry(registryPath);
  const entry = getOrCreateEntry(registry, artifact);
  const drift = loadMatchingDriftReports(artifact, entry.fingerprint);
  const adjustedLabel = driftAdjustedLabel(computeConfidence(entry).label, drift);
  // Same gate as every other unattended caller (src/replay/execution-policy.ts) -- a canary
  // is not a backdoor around approval/confidence. If this artifact isn't trusted enough for
  // unattended execution, the canary correctly reports that as the health signal itself.
  const allowRisky = effectiveAllowRisky({ requestedAllowRisky: true, approvalState: entry.approvalState, driftAdjustedLabel: adjustedLabel });

  const runId = newRunId("replay");
  const logger = new EvidenceLogger({ runId, runType: "replay" });
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });

  console.log(`Canary check: ${artifact.name} v${artifact.version} (${entry.fingerprint})`);

  try {
    await surface.launch("about:blank");
    const policy = new GuardrailsPolicy();
    const result = await replay({ artifact, params, surface, policy, logger, runId, allowRisky });
    logger.writeJson("replay-result.json", result);
    recordReplayOutcome(entry, { runId, timestamp: new Date().toISOString(), status: result.status });
    saveRegistry(registryPath, registry);

    const stability = computeStabilitySignal(entry.history, windowSize);

    // Recorded to a dedicated, canary-specific history (not the registry's mixed replay
    // history above) so a trend over this SCHEDULED CHECK's own past invocations can be
    // computed -- distinct from "how do the last few runs of any kind look," which is all
    // computeStabilitySignal can answer, since it has no memory across separate
    // canary-check processes and mixes canary runs together with ad-hoc replay/invoke calls.
    appendCanaryRecord(canaryHistoryPath, { timestamp: new Date().toISOString(), artifactId: artifact.id, fingerprint: entry.fingerprint, status: result.status });
    const canaryHistory = loadCanaryHistory(canaryHistoryPath, artifact.id, entry.fingerprint);
    const trend = computeCanaryTrend(canaryHistory);

    console.log(`Result: ${result.status}`);
    console.log(
      `Stability (last ${stability.recentRuns}/${stability.windowSize} runs): ${stability.recentCleanCount} clean, ` +
        `${stability.recentFailureCount} failed -- ${stability.healthy ? "HEALTHY" : stability.isFlaky ? "FLAKY" : "UNHEALTHY"}` +
        `${stability.justDegraded ? " (just degraded -- this is new)" : ""}`
    );
    console.log(`Trend (${trend.totalChecks} canary check(s) recorded): ${trend.consecutiveUnhealthy} consecutive unhealthy check(s)${trend.isRegressing ? " -- REGRESSING" : ""}`);

    process.exitCode = trend.isRegressing ? 3 : stability.healthy ? 0 : 1;
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
