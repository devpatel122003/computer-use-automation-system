import type { CapabilityArtifact } from "../artifact/schema.js";
import type { ApprovalState, ConfidenceScore } from "../artifact/registry.js";
import type { StepDriftReport } from "../replay/drift.js";
import { formatDuration, formatSpeedup, type AggregateMetrics } from "./metrics.js";

/**
 * Plain server-rendered HTML, no client JS -- a read-only ops view, not a product surface.
 * Colors follow the dataviz skill's validated status palette (tinted badge background +
 * a darkened, higher-contrast step of the same hue as text, plus an icon, so status is
 * never carried by hue alone). See REPORT.md for why this exists: it turns six things
 * already built (schema, registry, drift, evidence) into one glance instead of five CLI
 * invocations.
 */

export interface CapabilityView {
  artifact: CapabilityArtifact;
  fingerprint: string;
  approvalState: ApprovalState;
  confidence: ConfidenceScore;
  drift: StepDriftReport[];
  driftRunsMatched: number;
  discoveryMetrics: AggregateMetrics | null;
  replayMetrics: AggregateMetrics | null;
}

type Tone = "good" | "warning" | "serious" | "muted";

const TONE_STYLE: Record<Tone, { bg: string; fg: string; icon: string }> = {
  good: { bg: "#e3f7e3", fg: "#0a6b0a", icon: "✓" },
  warning: { bg: "#fff3d6", fg: "#8a5a00", icon: "⚠" },
  serious: { bg: "#fde7de", fg: "#a8431f", icon: "⚠" },
  muted: { bg: "#eeeeec", fg: "#52514e", icon: "–" },
};

function badge(label: string, tone: Tone): string {
  const s = TONE_STYLE[tone];
  return `<span class="badge" style="background:${s.bg};color:${s.fg}">${s.icon} ${escapeHtml(label)}</span>`;
}

function approvalBadge(state: ApprovalState): string {
  return badge(state, state === "approved" ? "good" : "warning");
}

function confidenceBadge(confidence: ConfidenceScore): string {
  const tone: Tone =
    confidence.label === "high" ? "good" : confidence.label === "medium" ? "warning" : confidence.label === "low" ? "serious" : "muted";
  return badge(confidence.label, tone);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function statTile(label: string, value: string, sub?: string, deltaTone?: Tone): string {
  const deltaStyle = deltaTone ? `style="color:${TONE_STYLE[deltaTone].fg}"` : "";
  return `
    <div class="stat-tile">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub" ${deltaStyle}>${escapeHtml(sub)}</div>` : ""}
    </div>`;
}

function costTimeSection(view: CapabilityView): string {
  const { discoveryMetrics, replayMetrics } = view;
  if (!discoveryMetrics && !replayMetrics) {
    return `<div class="section-empty">No discovery or replay runs recorded yet for this capability.</div>`;
  }

  const tiles: string[] = [];
  if (discoveryMetrics) {
    tiles.push(
      statTile(
        "Discovery (LLM-driven)",
        formatDuration(discoveryMetrics.avgDurationMs),
        `avg over ${discoveryMetrics.runCount} run(s) · ${discoveryMetrics.avgLlmCalls.toFixed(1)} model calls/run`
      )
    );
  }
  if (replayMetrics) {
    tiles.push(
      statTile(
        "Replay (deterministic)",
        formatDuration(replayMetrics.avgDurationMs),
        `avg over ${replayMetrics.runCount} run(s) · 0 model calls`
      )
    );
  }
  if (discoveryMetrics && replayMetrics) {
    const speedup = formatSpeedup(discoveryMetrics.avgDurationMs, replayMetrics.avgDurationMs);
    tiles.push(
      statTile(
        "Replay vs. discovery",
        speedup ? `${speedup} faster` : "n/a",
        `${discoveryMetrics.avgLlmCalls.toFixed(1)} model call(s) avoided, every invocation`,
        "good"
      )
    );
  }
  return `<div class="stat-row">${tiles.join("")}</div>`;
}

function paramsTable(artifact: CapabilityArtifact): string {
  const rows = artifact.inputParams
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.name)}</td><td>${p.type}</td><td>${p.required ? "yes" : "no"}</td><td>${p.sensitive ? "yes" : "no"}</td><td>${escapeHtml(p.description ?? "")}</td></tr>`
    )
    .join("");
  return `
    <table class="data-table">
      <thead><tr><th>Input param</th><th>Type</th><th>Required</th><th>Sensitive</th><th>Description</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="empty">none</td></tr>`}</tbody>
    </table>`;
}

function outputsTable(artifact: CapabilityArtifact): string {
  const rows = artifact.outputSchema
    .map((o) => `<tr><td>${escapeHtml(o.name)}</td><td>${o.type}</td><td>${escapeHtml(o.sourceStepId)}</td><td>${escapeHtml(o.description ?? "")}</td></tr>`)
    .join("");
  return `
    <table class="data-table">
      <thead><tr><th>Output</th><th>Type</th><th>From step</th><th>Description</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">none</td></tr>`}</tbody>
    </table>`;
}

function driftTable(view: CapabilityView): string {
  if (view.driftRunsMatched === 0) {
    return `<div class="section-empty">No replay runs recorded yet for this exact artifact content (fingerprint ${view.fingerprint}).</div>`;
  }
  const rows = view.drift
    .map((r) => {
      const observed = Object.entries(r.observedCounts)
        .map(([s, c]) => `${s}:${c}`)
        .join(", ");
      const flag = r.driftCount > 0 ? badge("drift", "warning") : badge("stable", "good");
      return `<tr><td>${escapeHtml(r.stepId)}</td><td>${escapeHtml(r.description)}</td><td>${r.expectedStrategy}</td><td>${escapeHtml(observed)}</td><td>${r.driftCount}/${r.totalObservations}</td><td>${flag}</td></tr>`;
    })
    .join("");
  return `
    <div class="section-note">Across ${view.driftRunsMatched} matching replay run(s).</div>
    <table class="data-table">
      <thead><tr><th>Step</th><th>Description</th><th>Expected</th><th>Observed</th><th>Drift</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">no steps with a locator</td></tr>`}</tbody>
    </table>`;
}

function capabilityCard(view: CapabilityView): string {
  const { artifact, confidence } = view;
  return `
    <section class="card">
      <div class="card-header">
        <h2>${escapeHtml(artifact.name)} <span class="muted">v${escapeHtml(artifact.version)}</span></h2>
        <div class="badges">${approvalBadge(view.approvalState)} ${confidenceBadge(confidence)}</div>
      </div>
      <p class="description">${escapeHtml(artifact.description)}</p>
      <div class="meta">fingerprint <code>${view.fingerprint}</code> · ${confidence.successCount}/${confidence.totalRuns} clean runs · app: ${escapeHtml(artifact.target.appId)}</div>

      <h3>Discovery vs. replay</h3>
      ${costTimeSection(view)}

      <h3>Contract</h3>
      ${paramsTable(artifact)}
      ${outputsTable(artifact)}

      <h3>UI-drift signal</h3>
      ${driftTable(view)}
    </section>`;
}

export function renderDashboard(views: CapabilityView[]): string {
  const cards = views.length > 0 ? views.map(capabilityCard).join("\n") : `<div class="section-empty">No capability artifacts found under evidence/artifacts.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Capability Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --border: rgba(11,11,11,0.10);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.45;
  }
  header {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .sub { color: var(--text-secondary); font-size: 13px; }
  main { padding: 24px 32px; max-width: 980px; margin: 0 auto; }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 24px;
  }
  .card-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .card-header h2 { margin: 0; font-size: 17px; }
  .badges { display: flex; gap: 6px; }
  .description { color: var(--text-secondary); margin: 8px 0; }
  .meta { color: var(--text-muted); font-size: 12px; margin-bottom: 16px; }
  .meta code { background: var(--page); padding: 1px 5px; border-radius: 4px; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-secondary); margin: 20px 0 8px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  }
  .stat-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-tile {
    flex: 1 1 200px;
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .stat-label { font-size: 12px; color: var(--text-secondary); }
  .stat-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .stat-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 10px; }
  .data-table th, .data-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .data-table th { color: var(--text-secondary); font-weight: 600; }
  .data-table td.empty { color: var(--text-muted); font-style: italic; }
  .section-empty, .section-note { color: var(--text-muted); font-size: 13px; }
  .muted { color: var(--text-muted); font-weight: 400; font-size: 13px; }
  footer { padding: 24px 32px; color: var(--text-muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
  <header>
    <h1>Capability Dashboard</h1>
    <div class="sub">Generated ${new Date().toISOString()} · read-only, recomputed on every request from evidence/artifacts and evidence/runs</div>
  </header>
  <main>
    ${cards}
  </main>
  <footer>No writes happen from this page. Refresh after a discovery/replay/approve run to see updated state.</footer>
</body>
</html>`;
}
