import type { LogEvent } from "./logger.js";

/**
 * A compliance-facing view of the same evidence everything else in this repo already
 * writes -- for an audience the dashboard/drift-report never addressed: a bank's
 * compliance/audit function, not a developer. The brief's own words: "this is regulated
 * financial data." Every field here is read from evidence that was already redacted at
 * write time (src/guardrails/redaction.ts) -- this module never re-derives or re-touches
 * raw params, it only reads what's already safe to read.
 */

export interface RiskyActionRecord {
  /** The confirmation prompt's own reason text -- names the route/step, not a secret. */
  context: string;
  approved: boolean;
}

export interface RunAuditEntry {
  runId: string;
  runType: "discovery" | "replay";
  startedAt: string;
  endedAt: string;
  /** Best-effort human label -- an artifact name for replay, the (already-redacted) goal
   *  string for discovery. Never a raw param value. */
  capabilityLabel: string;
  tenantId?: string;
  fingerprint?: string;
  outcome: string;
  riskyActions: RiskyActionRecord[];
  evidenceDir: string;
}

function inferRunType(runId: string): "discovery" | "replay" {
  return runId.startsWith("discovery-") ? "discovery" : "replay";
}

function detailOf(event: LogEvent | undefined): Record<string, unknown> {
  return (event?.detail ?? {}) as Record<string, unknown>;
}

/**
 * Builds one audit entry from a run's already-parsed log events plus its result JSON (if
 * any -- a run that crashed before writing one still gets an entry, just with outcome
 * "incomplete"). Pure function: no filesystem access, so it's unit-testable without a real
 * evidence tree.
 */
export function buildRunAuditEntry(runId: string, events: LogEvent[], resultJson: unknown, evidenceDir: string): RunAuditEntry | null {
  if (events.length === 0) return null;

  const runType = inferRunType(runId);
  const startEvent = events.find((e) => e.phase === "start");
  const startDetail = detailOf(startEvent);

  const riskyActions: RiskyActionRecord[] = events
    .filter((e) => e.phase === "escalation")
    .map((e) => detailOf(e))
    .filter((d) => typeof d.approved === "boolean")
    .map((d) => ({ context: String(d.reason ?? ""), approved: d.approved as boolean }));

  const result = (resultJson ?? {}) as { status?: string };

  let capabilityLabel = "unknown";
  let tenantId: string | undefined;
  let fingerprint: string | undefined;

  if (runType === "discovery") {
    capabilityLabel = typeof startDetail.goal === "string" ? startDetail.goal : "(discovery run)";
  } else {
    const secondStart = events.filter((e) => e.phase === "start").find((e) => typeof detailOf(e).artifactId === "string");
    capabilityLabel = secondStart ? String(detailOf(secondStart).artifactId) : "(replay run)";
    fingerprint = typeof startDetail.fingerprint === "string" ? startDetail.fingerprint : undefined;
    const override = startDetail.tenantOverride as { tenantId?: string } | undefined;
    tenantId = override?.tenantId;
  }

  return {
    runId,
    runType,
    startedAt: events[0]!.ts,
    endedAt: events[events.length - 1]!.ts,
    capabilityLabel,
    tenantId,
    fingerprint,
    outcome: result.status ?? "incomplete (no result recorded -- run may have crashed or been interrupted)",
    riskyActions,
    evidenceDir,
  };
}

function escapeMd(value: string): string {
  return value.replace(/[|`*_[\]]/g, (c) => `\\${c}`);
}

export function renderAuditReportMarkdown(entries: RunAuditEntry[], generatedAt: string): string {
  const sorted = [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const totalRisky = sorted.reduce((sum, e) => sum + e.riskyActions.length, 0);
  const approvedRisky = sorted.reduce((sum, e) => sum + e.riskyActions.filter((r) => r.approved).length, 0);
  const byRunType = { discovery: sorted.filter((e) => e.runType === "discovery").length, replay: sorted.filter((e) => e.runType === "replay").length };
  const byOutcome = new Map<string, number>();
  for (const e of sorted) byOutcome.set(e.outcome, (byOutcome.get(e.outcome) ?? 0) + 1);

  const lines: string[] = [
    "# Compliance Audit Report",
    "",
    `Generated: ${generatedAt}`,
    `Covers ${sorted.length} run(s) currently in evidence/runs.`,
    "",
    "> **Limitation, disclosed rather than hidden:** this system does not currently record",
    "> *which human* approved a risky action or an artifact (see REPORT.md §7) -- only",
    "> *that* an action was approved/declined and when. A real deployment auditing against",
    "> this report would still need an authenticated-reviewer identity layer on top.",
    "",
    "## Summary",
    "",
    `- Discovery runs: ${byRunType.discovery} · Replay runs: ${byRunType.replay}`,
    `- Risky actions requiring confirmation: ${totalRisky} total, ${approvedRisky} approved, ${totalRisky - approvedRisky} declined`,
    "- Outcomes: " + Array.from(byOutcome.entries()).map(([k, v]) => `${k} (${v})`).join(", "),
    "",
    "## Run-by-run detail",
    "",
  ];

  for (const e of sorted) {
    lines.push(`### \`${e.runId}\``);
    lines.push("");
    lines.push(`- Type: ${e.runType}`);
    lines.push(`- Started: ${e.startedAt} · Ended: ${e.endedAt}`);
    lines.push(`- Capability: ${escapeMd(e.capabilityLabel)}`);
    if (e.fingerprint) lines.push(`- Artifact fingerprint: \`${e.fingerprint}\``);
    if (e.tenantId) lines.push(`- Tenant: ${escapeMd(e.tenantId)}`);
    lines.push(`- Outcome: **${e.outcome}**`);
    if (e.riskyActions.length > 0) {
      lines.push(`- Risky actions:`);
      for (const r of e.riskyActions) {
        lines.push(`  - ${r.approved ? "✓ approved" : "✗ declined"} — ${escapeMd(r.context)}`);
      }
    }
    lines.push(`- Evidence: \`${e.evidenceDir}\``);
    lines.push("");
  }

  return lines.join("\n");
}
