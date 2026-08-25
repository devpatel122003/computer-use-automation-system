import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMatchingDriftReports, loadMatchingRunLogs } from "./drift-loader.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../artifact/schema.js";

function artifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    id: "x",
    name: "X",
    description: "d",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputSchema: [],
    steps: [
      {
        id: "step-1",
        actionType: "click",
        description: 'Click button "Go"',
        locator: [{ strategy: "role", role: "button", name: "Go", nth: 0, confidence: "high", rationale: "r" }],
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
    ],
    successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
    knownOutcomes: [],
  });
}

function tempRunsDir(): string {
  const dir = path.join(os.tmpdir(), `drift-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRun(runsDir: string, name: string, fingerprint: string, matchedStrategy: string, tenantOverride?: { tenantId: string }): void {
  const dir = path.join(runsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { ts: "2026-01-01T00:00:00.000Z", step: 0, phase: "start", summary: "s", detail: { fingerprint, tenantOverride } },
    { ts: "2026-01-01T00:00:01.000Z", step: 1, phase: "act", summary: "a", detail: { action: { type: "click" }, result: { ok: true, matchedStrategy } } },
  ];
  fs.writeFileSync(path.join(dir, "log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
}

describe("loadMatchingDriftReports", () => {
  it("returns an empty list when the runs directory doesn't exist", () => {
    expect(loadMatchingDriftReports(artifact(), "fp1", path.join(os.tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  it("only aggregates runs matching the given fingerprint", () => {
    const dir = tempRunsDir();
    writeRun(dir, "replay-1", "fp1", "role");
    writeRun(dir, "replay-2", "fp2", "css_structural"); // different fingerprint -- must not count
    writeRun(dir, "not-a-replay-dir", "fp1", "css_structural"); // wrong prefix -- must not count

    const report = loadMatchingDriftReports(artifact(), "fp1", dir);
    expect(report).toHaveLength(1);
    expect(report[0]?.observedCounts).toEqual({ role: 1 });
    expect(report[0]?.driftCount).toBe(0);
  });

  it("excludes a run that declares a tenant override from the BASE artifact's own drift, even when the fingerprint collides -- the real bug found live: a URL-only override shares the base artifact's content fingerprint, so a run testing an incompatible tenant page would otherwise silently pollute the base artifact's own trust signal", () => {
    const dir = tempRunsDir();
    writeRun(dir, "replay-1", "fp1", "role"); // a genuine, unmodified-artifact run
    writeRun(dir, "replay-2", "fp1", "css_structural", { tenantId: "some-other-tenant" }); // same fingerprint, but a declared override -- must not count toward the base view

    const baseReport = loadMatchingDriftReports(artifact(), "fp1", dir); // no expectedTenantId = base artifact's own view
    expect(baseReport[0]?.observedCounts).toEqual({ role: 1 });
    expect(baseReport[0]?.totalObservations).toBe(1);
  });

  it("includes only the matching tenant's own runs when a tenantId is given, even if another tenant collides on the same fingerprint", () => {
    const dir = tempRunsDir();
    writeRun(dir, "replay-1", "fp1", "role", { tenantId: "northgate-cu" });
    writeRun(dir, "replay-2", "fp1", "css_structural", { tenantId: "some-other-tenant" });
    writeRun(dir, "replay-3", "fp1", "role"); // no override at all -- must not count toward either tenant's view

    const report = loadMatchingDriftReports(artifact(), "fp1", dir, "northgate-cu");
    expect(report[0]?.observedCounts).toEqual({ role: 1 });
    expect(report[0]?.totalObservations).toBe(1);
  });
});

describe("loadMatchingRunLogs", () => {
  it("returns only the matching runs' full event logs, not just their drift matches", () => {
    const dir = tempRunsDir();
    writeRun(dir, "replay-1", "fp1", "role");
    writeRun(dir, "replay-2", "fp2", "css_structural");

    const logs = loadMatchingRunLogs("fp1", dir);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.some((e) => e.phase === "start")).toBe(true);
  });
});
