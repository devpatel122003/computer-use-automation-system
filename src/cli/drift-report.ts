import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { fingerprintArtifact } from "../artifact/registry.js";
import { extractStepMatches, summarizeDrift } from "../replay/drift.js";
import type { LogEvent } from "../evidence/logger.js";
import { parseArgs } from "./args.js";

function readRunLog(runDir: string): LogEvent[] {
  const logPath = path.join(runDir, "log.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "evidence/artifacts/open-sub-account.artifact.json";
  const runsDir = args["runs-dir"] ?? "evidence/runs";

  const artifact = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(artifactPath, "utf-8")));
  const fingerprint = fingerprintArtifact(artifact);

  const runDirs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => d.startsWith("replay-")) : [];
  const allMatches: Array<{ stepNum: number; matchedStrategy: import("../surface/types.js").LocatorStrategy }> = [];
  let matchedRuns = 0;

  for (const dir of runDirs) {
    const events = readRunLog(path.join(runsDir, dir));
    const startEvent = events.find((e) => e.phase === "start");
    const runFingerprint = (startEvent?.detail as { fingerprint?: string } | undefined)?.fingerprint;
    // Only runs of this EXACT recorded content -- a different fingerprint (a re-recording,
    // or a different tenant-override) has its own locator candidates, so "step-6 drifted"
    // wouldn't mean the same thing across them.
    if (runFingerprint !== fingerprint) continue;
    matchedRuns += 1;
    allMatches.push(...extractStepMatches(events));
  }

  const report = summarizeDrift(artifact, allMatches);

  console.log(`Drift report: ${artifact.name} v${artifact.version} (${fingerprint})`);
  console.log(`Runs matched: ${matchedRuns} of ${runDirs.length} replay run(s) under ${runsDir}\n`);

  if (report.length === 0) {
    console.log("No step executions recorded for this exact artifact content yet -- run some replays first.");
    return;
  }

  for (const r of report) {
    const countsStr = Object.entries(r.observedCounts)
      .map(([strategy, count]) => `${strategy}:${count}`)
      .join(", ");
    const flag = r.driftCount > 0 ? "  <-- DRIFT: falling back below its recorded top strategy" : "";
    console.log(`${r.stepId} -- ${r.description}`);
    console.log(`  expected: ${r.expectedStrategy} | observed: ${countsStr} | drift: ${r.driftCount}/${r.totalObservations}${flag}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
