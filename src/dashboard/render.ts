import type { CapabilityArtifact } from "../artifact/schema.js";
import type { ApprovalState, ConfidenceScore } from "../artifact/registry.js";
import type { TenantVariantEntry } from "../artifact/catalog.js";
import type { ConfidenceLabel, StepDriftReport } from "../replay/drift.js";
import { formatDuration, formatSpeedup, type AggregateMetrics } from "./metrics.js";

/** A tenant variant plus its OWN drift signal -- computed by the caller (dashboard/server.ts),
 *  same "artifact/catalog.ts stays about artifact+registry, replay-derived signals are
 *  merged one layer up" split the base capability's own drift already follows. This is the
 *  real (not fabricated) fleet-drift slice: a cross-tenant comparison built from whatever
 *  tenants actually exist (today: the base app + northgate-cu), not a simulated fleet. */
export interface TenantVariantView extends TenantVariantEntry {
  drift: StepDriftReport[];
}

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
  driftAdjustedLabel: ConfidenceLabel;
  tenantVariants: TenantVariantView[];
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

function confidenceLabelTone(label: ConfidenceLabel): Tone {
  return label === "high" ? "good" : label === "medium" ? "warning" : label === "low" ? "serious" : "muted";
}

function confidenceBadges(confidence: ConfidenceScore, driftAdjusted: ConfidenceLabel): string {
  const raw = badge(confidence.label, confidenceLabelTone(confidence.label));
  // Only show the second badge when drift actually changed the picture -- a redundant
  // badge that always repeats the same word next to itself is noise, not a signal.
  if (driftAdjusted === confidence.label) return raw;
  return `${raw} ${badge(`drift-capped to ${driftAdjusted}`, "warning")}`;
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

function tenantVariantsTable(view: CapabilityView): string {
  if (view.tenantVariants.length === 0) return "";
  const rows = view.tenantVariants
    .map((v) => {
      const driftCount = v.drift.filter((r) => r.driftCount > 0).length;
      const driftCell = v.drift.length === 0 ? `<span class="muted">no runs yet</span>` : driftCount > 0 ? badge(`${driftCount} step(s) drifting`, "warning") : badge("stable", "good");
      return `<tr><td>${escapeHtml(v.tenantId)}</td><td><code>${v.fingerprint}</code></td><td>${approvalBadge(v.approvalState)}</td><td>${badge(v.confidence.label, confidenceLabelTone(v.confidence.label))}</td><td>${v.confidence.successCount}/${v.confidence.totalRuns}</td><td>${driftCell}</td></tr>`;
    })
    .join("");
  return `
    <h3>Tenant variants</h3>
    <div class="section-note">Same base artifact, adapted per tenant via config/tenant-overrides/ -- each earns its own trust independently (REPORT.md "Cross-tenant reuse").</div>
    <table class="data-table">
      <thead><tr><th>Tenant</th><th>Fingerprint</th><th>Approval</th><th>Confidence</th><th>Clean runs</th><th>Drift</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * The real (not fabricated) fleet-drift slice: a per-step comparison across every surface
 * this capability actually runs on today -- the base app and whatever tenant variants have
 * real replay history. REPORT.md's fleet vision describes aggregating "artifact X, tenant
 * Y, step 6: drifting" across hundreds of tenants; this is that exact aggregation, just
 * built honestly at the two real surfaces this repo has, rather than simulating a fleet
 * that doesn't exist. Adding a third tenant is adding a row to config/tenant-overrides/,
 * not new code.
 */
function crossTenantDriftMatrix(view: CapabilityView): string {
  const columns: Array<{ label: string; drift: StepDriftReport[]; hasRuns: boolean }> = [
    { label: "base", drift: view.drift, hasRuns: view.driftRunsMatched > 0 },
    ...view.tenantVariants.map((v) => ({ label: v.tenantId, drift: v.drift, hasRuns: v.drift.length > 0 })),
  ];
  if (columns.length < 2) return ""; // no tenant variants exist yet -- nothing to compare

  const stepIds = Array.from(new Set(columns.flatMap((c) => c.drift.map((r) => r.stepId))));
  if (stepIds.length === 0) return "";

  const stepDescriptions = new Map<string, string>();
  for (const c of columns) for (const r of c.drift) stepDescriptions.set(r.stepId, r.description);

  const rows = stepIds
    .map((stepId) => {
      const cells = columns
        .map((c) => {
          const r = c.drift.find((d) => d.stepId === stepId);
          if (!r) return `<td>${c.hasRuns ? `<span class="muted">n/a</span>` : `<span class="muted">no runs</span>`}</td>`;
          return `<td>${r.driftCount > 0 ? badge("drift", "warning") : badge("stable", "good")}</td>`;
        })
        .join("");
      return `<tr><td>${escapeHtml(stepId)}</td><td>${escapeHtml(stepDescriptions.get(stepId) ?? "")}</td>${cells}</tr>`;
    })
    .join("");

  return `
    <h3>Cross-tenant drift comparison</h3>
    <div class="section-note">Every surface this capability actually runs on today, side by side, per step.</div>
    <table class="data-table">
      <thead><tr><th>Step</th><th>Description</th>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function capabilityCard(view: CapabilityView): string {
  const { artifact, confidence } = view;
  return `
    <section class="card">
      <div class="card-header">
        <h2>${escapeHtml(artifact.name)} <span class="muted">v${escapeHtml(artifact.version)}</span></h2>
        <div class="badges">${approvalBadge(view.approvalState)} ${confidenceBadges(confidence, view.driftAdjustedLabel)}</div>
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

      ${tenantVariantsTable(view)}
      ${crossTenantDriftMatrix(view)}
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
