import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import { loadCapabilityCatalog, loadTenantVariants } from "../artifact/catalog.js";
import { driftAdjustedLabel, extractStepMatches, summarizeDrift } from "../replay/drift.js";
import { loadMatchingRunLogs } from "../replay/drift-loader.js";
import { aggregateRunMetrics, computeRunMetrics } from "./metrics.js";
import { renderDashboard, type CapabilityView, type TenantVariantView } from "./render.js";
import type { LogEvent } from "../evidence/logger.js";
import { requireBasicAuth } from "../http/api-key-auth.js";
import { requestLog } from "../http/request-log.js";

/**
 * Read-only ops dashboard: turns the artifact schema, confidence registry, and UI-drift
 * signal (each already real and separately CLI-accessible) into one page instead of five
 * commands. Recomputes from disk on every request -- no state of its own, nothing to get
 * out of sync, safe to leave running through a live demo while other commands mutate
 * evidence/runs and evidence/artifacts/registry.json underneath it. Confidence/approval/
 * drift state is real operational data about a production capability, not public
 * documentation, so it sits behind HTTP Basic auth (DASHBOARD_PASSWORD -- see
 * .env.example; the browser prompts for the credential natively, no login form needed);
 * /health stays open for orchestrator checks.
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
    // undefined tenantId -- only runs of the *unmodified* artifact count toward its own
    // drift/metrics, even if a tenant override happens to collide on content fingerprint
    // (see drift-loader.ts's own note on why this matters).
    const matchedRunLogs = loadMatchingRunLogs(fingerprint, RUNS_DIR, undefined);

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
      const variantRunLogs = loadMatchingRunLogs(variant.fingerprint, RUNS_DIR, variant.tenantId);
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
app.disable("x-powered-by");
// hsts: false -- this server is plain HTTP on localhost only, never TLS; helmet's default
// Strict-Transport-Security header is a promise it can't keep. A real bug, reproduced live
// in Safari/WebKit against src/chat-ui/server.ts (same default): the browser believed the
// header and upgraded later same-origin requests to https, which then failed outright.
app.use(helmet({ hsts: false }));
app.use(requestLog("dashboard"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(requireBasicAuth("DASHBOARD_PASSWORD"));

app.get("/", (_req, res) => {
  res.send(renderDashboard(buildCapabilityViews()));
});

const PORT = Number(process.env.DASHBOARD_PORT ?? 4600);
app.listen(PORT, () => {
  console.log(`Capability dashboard listening on http://localhost:${PORT}`);
});
