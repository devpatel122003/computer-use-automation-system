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

/**
 * Every replay run's log events, filtered to this exact content fingerprint -- the raw
 * material both the drift signal and the dashboard's cost/time metrics are built from.
 *
 * `expectedTenantId` disambiguates a real collision found while producing evidence: a
 * tenant override that changes only `baseUrlPattern` (e.g. a negative-control fixture
 * proving the *lack* of a locator override breaks things) produces the exact same content
 * fingerprint as the base artifact, since the fingerprint deliberately excludes
 * `baseUrlPattern` (see registry.ts). Without this, a run explicitly testing the base
 * artifact against an incompatible tenant page would silently count toward the *base*
 * artifact's own drift/confidence signal just because the hashes happened to collide. A
 * run's own declared `tenantOverride` (logged on its `start` event) is the source of truth
 * for "which surface was this run actually against," not the coincidental fingerprint --
 * pass `undefined` for the base artifact's own view (only unmodified-artifact runs count),
 * or a specific tenantId for that tenant's view (only that exact tenant's runs count).
 */
export function loadMatchingRunLogs(fingerprint: string, runsDir = "evidence/runs", expectedTenantId?: string): LogEvent[][] {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((d) => d.startsWith("replay-"))
    .map((dir) => readRunLog(path.join(runsDir, dir)))
    .filter((events) => {
      const start = events.find((e) => e.phase === "start");
      const detail = (start?.detail ?? {}) as { fingerprint?: string; tenantOverride?: { tenantId?: string } };
      if (detail.fingerprint !== fingerprint) return false;
      const declaredTenantId = detail.tenantOverride?.tenantId;
      return expectedTenantId === undefined ? declaredTenantId === undefined : declaredTenantId === expectedTenantId;
    });
}

export function loadMatchingDriftReports(
  artifact: CapabilityArtifact,
  fingerprint: string,
  runsDir = "evidence/runs",
  expectedTenantId?: string
): StepDriftReport[] {
  const matches = loadMatchingRunLogs(fingerprint, runsDir, expectedTenantId).flatMap((events) => extractStepMatches(events));
  return summarizeDrift(artifact, matches);
}
