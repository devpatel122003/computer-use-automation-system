import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendCanaryRecord, computeCanaryTrend, loadCanaryHistory, type CanaryCheckRecord } from "./canary-history.js";

function tempHistoryPath(): string {
  return path.join(os.tmpdir(), `canary-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function record(overrides: Partial<CanaryCheckRecord> = {}): CanaryCheckRecord {
  return { timestamp: "2026-01-01T00:00:00.000Z", artifactId: "open-sub-account", fingerprint: "fp1", status: "success", ...overrides };
}

describe("appendCanaryRecord / loadCanaryHistory", () => {
  it("returns an empty list when the history file doesn't exist yet", () => {
    expect(loadCanaryHistory(tempHistoryPath(), "open-sub-account", "fp1")).toEqual([]);
  });

  it("appends across multiple calls and loads them back in order", () => {
    const p = tempHistoryPath();
    appendCanaryRecord(p, record({ timestamp: "t1" }));
    appendCanaryRecord(p, record({ timestamp: "t2" }));
    const loaded = loadCanaryHistory(p, "open-sub-account", "fp1");
    expect(loaded.map((r) => r.timestamp)).toEqual(["t1", "t2"]);
  });

  it("filters to the given artifactId + fingerprint, excluding other artifacts/fingerprints in the same file", () => {
    const p = tempHistoryPath();
    appendCanaryRecord(p, record({ timestamp: "t1" }));
    appendCanaryRecord(p, record({ timestamp: "t2", fingerprint: "fp2" }));
    appendCanaryRecord(p, record({ timestamp: "t3", artifactId: "create-member" }));
    const loaded = loadCanaryHistory(p, "open-sub-account", "fp1");
    expect(loaded.map((r) => r.timestamp)).toEqual(["t1"]);
  });

  it("skips a malformed trailing line (e.g. a killed process mid-append) rather than failing outright", () => {
    const p = tempHistoryPath();
    appendCanaryRecord(p, record({ timestamp: "t1" }));
    fs.appendFileSync(p, '{"truncated": tr');
    const loaded = loadCanaryHistory(p, "open-sub-account", "fp1");
    expect(loaded.map((r) => r.timestamp)).toEqual(["t1"]);
  });
});

describe("computeCanaryTrend", () => {
  it("reports no regression with no history at all", () => {
    expect(computeCanaryTrend([])).toEqual({ totalChecks: 0, consecutiveUnhealthy: 0, isRegressing: false });
  });

  it("a single failure is not yet regressing", () => {
    const trend = computeCanaryTrend([record({ status: "failure" })]);
    expect(trend.consecutiveUnhealthy).toBe(1);
    expect(trend.isRegressing).toBe(false);
  });

  it("exactly 3 consecutive failures IS regressing", () => {
    const history = [record({ status: "failure" }), record({ status: "failure" }), record({ status: "failure" })];
    const trend = computeCanaryTrend(history);
    expect(trend.consecutiveUnhealthy).toBe(3);
    expect(trend.isRegressing).toBe(true);
  });

  it("a failure-then-recovery resets the streak -- not regressing", () => {
    const history = [record({ status: "failure" }), record({ status: "failure" }), record({ status: "failure" }), record({ status: "success" })];
    const trend = computeCanaryTrend(history);
    expect(trend.consecutiveUnhealthy).toBe(0);
    expect(trend.isRegressing).toBe(false);
  });

  it("treats a business_outcome the same as success -- both mean the replay engine correctly explained what happened", () => {
    const history = [record({ status: "failure" }), record({ status: "failure" }), record({ status: "failure" }), record({ status: "business_outcome" })];
    expect(computeCanaryTrend(history).isRegressing).toBe(false);
  });

  it("counts totalChecks regardless of clean/unhealthy mix", () => {
    expect(computeCanaryTrend([record(), record({ status: "failure" })]).totalChecks).toBe(2);
  });
});
