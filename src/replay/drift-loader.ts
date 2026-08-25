import fs from "node:fs";
import path from "node:path";
import type { CapabilityArtifact } from "../artifact/schema.js";
import type { LogEvent } from "../evidence/logger.js";
import { extractStepMatches, summarizeDrift, type StepDriftReport } from "./drift.js";

/**
 * The "filter evidence/runs to this artifact's exact fingerprint, then summarize drift"
 * aggregation was already duplicated between src/dashboard/server.ts and
 * src/cli/drift-report.ts before this file existed; factored out here so the confidence
 * circuit breaker (execution-policy.ts) doesn't become a third copy of the same logic.
 * drift.ts itself stays pure (no fs) so its unit tests don't need a filesystem; this module
 * is the I/O-consuming layer on top of it, the same split catalog.ts uses for artifacts.
 */

function readRunLog(runDir: string): LogEvent[] {
  const logPath = path.join(runDir, "log.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

/** Every replay run's log events, filtered to this exact content fingerprint -- the raw
 *  material both the drift signal and the dashboard's cost/time metrics are built from. */
export function loadMatchingRunLogs(fingerprint: string, runsDir = "evidence/runs"): LogEvent[][] {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((d) => d.startsWith("replay-"))
    .map((dir) => readRunLog(path.join(runsDir, dir)))
    .filter((events) => {
      const start = events.find((e) => e.phase === "start");
      return (start?.detail as { fingerprint?: string } | undefined)?.fingerprint === fingerprint;
    });
}

export function loadMatchingDriftReports(
  artifact: CapabilityArtifact,
  fingerprint: string,
  runsDir = "evidence/runs"
): StepDriftReport[] {
  const matches = loadMatchingRunLogs(fingerprint, runsDir).flatMap((events) => extractStepMatches(events));
  return summarizeDrift(artifact, matches);
}
