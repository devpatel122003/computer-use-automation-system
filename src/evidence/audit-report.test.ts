import { describe, expect, it } from "vitest";
import { buildRunAuditEntry, renderAuditReportMarkdown } from "./audit-report.js";
import type { LogEvent } from "./logger.js";

function evt(ts: string, phase: LogEvent["phase"], detail?: Record<string, unknown>, step = 0): LogEvent {
  return { ts, step, phase, summary: "s", detail };
}

describe("buildRunAuditEntry", () => {
  it("returns null for a run with no events at all", () => {
    expect(buildRunAuditEntry("replay-x", [], undefined, "evidence/runs/replay-x")).toBeNull();
  });

  it("builds a discovery entry from the goal (already redacted at write time) and the result status", () => {
    const events = [
      evt("2026-01-01T00:00:00.000Z", "start", { goal: "Sign on with password [REDACTED], look up member 10001" }),
      evt("2026-01-01T00:00:10.000Z", "end", { status: "finished" }),
    ];
    const entry = buildRunAuditEntry("discovery-x", events, { status: "finished" }, "evidence/runs/discovery-x");
    expect(entry?.runType).toBe("discovery");
    expect(entry?.capabilityLabel).toContain("[REDACTED]");
    expect(entry?.outcome).toBe("finished");
    expect(entry?.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry?.endedAt).toBe("2026-01-01T00:00:10.000Z");
  });

  it("builds a replay entry, pulling artifact id, fingerprint, and tenantId from the start events", () => {
    const events = [
      evt("2026-01-01T00:00:00.000Z", "start", { fingerprint: "fp1", tenantOverride: { tenantId: "northgate-cu" } }),
      evt("2026-01-01T00:00:01.000Z", "start", { artifactId: "open-sub-account" }),
    ];
    const entry = buildRunAuditEntry("replay-x", events, { status: "success" }, "evidence/runs/replay-x");
    expect(entry?.runType).toBe("replay");
    expect(entry?.capabilityLabel).toBe("open-sub-account");
    expect(entry?.fingerprint).toBe("fp1");
    expect(entry?.tenantId).toBe("northgate-cu");
    expect(entry?.outcome).toBe("success");
  });

  it("collects risky-action confirmations and declines from escalation-phase events", () => {
    const events = [
      evt("2026-01-01T00:00:00.000Z", "start", {}),
      evt("2026-01-01T00:00:01.000Z", "escalation", { reason: "Step step-10: Click button \"Submit\"", approved: true }),
      evt("2026-01-01T00:00:02.000Z", "escalation", { reason: "No member found", approved: false }),
      evt("2026-01-01T00:00:03.000Z", "escalation", { reason: "Agent requested escalation" }), // no `approved` field -- not a risky-action decision, must be excluded
    ];
    const entry = buildRunAuditEntry("replay-x", events, { status: "failure" }, "evidence/runs/replay-x");
    expect(entry?.riskyActions).toEqual([
      { context: 'Step step-10: Click button "Submit"', approved: true },
      { context: "No member found", approved: false },
    ]);
  });

  it("marks a run with no result JSON as incomplete rather than guessing an outcome", () => {
    const events = [evt("2026-01-01T00:00:00.000Z", "start", {})];
    const entry = buildRunAuditEntry("replay-x", events, undefined, "evidence/runs/replay-x");
    expect(entry?.outcome).toMatch(/incomplete/);
  });

  it("includes operatorId when the start event's detail carries one (a capability-API-triggered run)", () => {
    const events = [evt("2026-01-01T00:00:00.000Z", "start", { operatorId: "local-operator", fingerprint: "fp1" })];
    const entry = buildRunAuditEntry("replay-x", events, { status: "success" }, "evidence/runs/replay-x");
    expect(entry?.operatorId).toBe("local-operator");
  });

  it("leaves operatorId undefined when absent (a discovery run or a local CLI invocation, neither of which authenticates)", () => {
    const events = [evt("2026-01-01T00:00:00.000Z", "start", { fingerprint: "fp1" })];
    const entry = buildRunAuditEntry("replay-x", events, { status: "success" }, "evidence/runs/replay-x");
    expect(entry?.operatorId).toBeUndefined();
  });
});

describe("renderAuditReportMarkdown", () => {
  it("summarizes counts and includes the reviewer-identity limitation disclosure", () => {
    const entries = [
      buildRunAuditEntry("replay-a", [evt("2026-01-01T00:00:00.000Z", "start", {})], { status: "success" }, "d/a")!,
      buildRunAuditEntry(
        "replay-b",
        [evt("2026-01-01T00:00:00.000Z", "start", {}), evt("2026-01-01T00:00:01.000Z", "escalation", { reason: "r", approved: false })],
        { status: "failure" },
        "d/b"
      )!,
    ];
    const report = renderAuditReportMarkdown(entries, "2026-01-01T00:00:00.000Z");
    expect(report).toContain("Discovery runs: 0");
    expect(report).toContain("Replay runs: 2");
    expect(report).toContain("Risky actions requiring confirmation: 1 total, 0 approved, 1 declined");
    expect(report).toContain("does not currently record");
    expect(report).toContain("replay-a");
    expect(report).toContain("replay-b");
  });

  it("escapes markdown-significant characters in free-text fields so a goal string can't break report formatting", () => {
    const entries = [buildRunAuditEntry("discovery-a", [evt("2026-01-01T00:00:00.000Z", "start", { goal: "look up *member* [10001]" })], { status: "finished" }, "d/a")!];
    const report = renderAuditReportMarkdown(entries, "2026-01-01T00:00:00.000Z");
    expect(report).toContain("look up \\*member\\* \\[10001\\]");
  });

  it("prints an Operator line when present", () => {
    const entries = [buildRunAuditEntry("replay-a", [evt("2026-01-01T00:00:00.000Z", "start", { operatorId: "alice" })], { status: "success" }, "d/a")!];
    const report = renderAuditReportMarkdown(entries, "2026-01-01T00:00:00.000Z");
    expect(report).toContain("- Operator: alice");
  });

  it("omits the Operator line when absent", () => {
    const entries = [buildRunAuditEntry("replay-a", [evt("2026-01-01T00:00:00.000Z", "start", {})], { status: "success" }, "d/a")!];
    const report = renderAuditReportMarkdown(entries, "2026-01-01T00:00:00.000Z");
    expect(report).not.toContain("- Operator:");
  });
});
