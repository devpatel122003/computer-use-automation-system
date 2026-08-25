import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { loadCapabilityCatalog, loadTenantVariants } from "../artifact/catalog.js";
import { driftAdjustedLabel, extractStepMatches, summarizeDrift } from "../replay/drift.js";
import { loadMatchingRunLogs } from "../replay/drift-loader.js";
import { aggregateRunMetrics, computeRunMetrics } from "./metrics.js";
import { renderDashboard, type CapabilityView, type TenantVariantView } from "./render.js";
import type { LogEvent } from "../evidence/logger.js";

/**
 * Read-only ops dashboard: turns the artifact schema, confidence registry, and UI-drift
 * signal (each already real and separately CLI-accessible) into one page instead of five
 * commands. Recomputes from disk on every request -- no state of its own, nothing to get
 * out of sync, safe to leave running through a live demo while other commands mutate
 * evidence/runs and evidence/artifacts/registry.json underneath it.
 */

const ARTIFACTS_DIR = "evidence/artifacts";
const RUNS_DIR = "evidence/runs";

function readRunLog(runDir: string): LogEvent[] {
  const logPath = path.join(runDir, "log.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

function listRunDirs(prefix: string): string[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR).filter((d) => d.startsWith(prefix));
}

function buildCapabilityViews(): CapabilityView[] {
  const catalog = loadCapabilityCatalog(ARTIFACTS_DIR);
  const discoveryDirs = listRunDirs("discovery-");

  // Discovery runs aren't tied to a saved artifact (there isn't one yet when they run), so
  // there's no fingerprint to filter them by -- every discovery run in evidence/runs is
  // treated as "discovery activity for whatever capability this repo currently records."
  // Fine for the one-capability reality of this repo; a fleet version would need discovery
  // runs to at least carry the goal/capability name they were attempting.
  const discoveryMetrics = aggregateRunMetrics(
    discoveryDirs
      .map((dir) => computeRunMetrics(dir, readRunLog(path.join(RUNS_DIR, dir))))
      .filter((m): m is NonNullable<typeof m> => m !== null)
  );

  return catalog.map(({ artifact, fingerprint, approvalState, confidence }) => {
    const matchedRunLogs = loadMatchingRunLogs(fingerprint, RUNS_DIR);

    const drift = summarizeDrift(artifact, matchedRunLogs.flatMap((events) => extractStepMatches(events)));
    const replayMetrics = aggregateRunMetrics(
      matchedRunLogs
        .map((events, i) => computeRunMetrics(`replay-${i}`, events))
        .filter((m): m is NonNullable<typeof m> => m !== null)
    );

    // Each tenant variant's OWN drift signal -- the real fleet-drift slice (REPORT.md
    // "Heterogeneity & multi-tenant"): a per-step comparison across every surface this
    // capability actually runs on, built from whichever tenants actually exist today.
    const tenantVariants: TenantVariantView[] = loadTenantVariants(artifact).map((variant) => {
      const variantRunLogs = loadMatchingRunLogs(variant.fingerprint, RUNS_DIR);
      return { ...variant, drift: summarizeDrift(variant.artifact, variantRunLogs.flatMap((events) => extractStepMatches(events))) };
    });

    return {
      artifact,
      fingerprint,
      approvalState,
      confidence,
      drift,
      driftRunsMatched: matchedRunLogs.length,
      driftAdjustedLabel: driftAdjustedLabel(confidence.label, drift),
      tenantVariants,
      discoveryMetrics,
      replayMetrics,
    } satisfies CapabilityView;
  });
}

const app = express();

app.get("/", (_req, res) => {
  res.send(renderDashboard(buildCapabilityViews()));
});

const PORT = Number(process.env.DASHBOARD_PORT ?? 4600);
app.listen(PORT, () => {
  console.log(`Capability dashboard listening on http://localhost:${PORT}`);
});
