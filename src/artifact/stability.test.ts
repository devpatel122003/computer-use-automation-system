import { describe, expect, it } from "vitest";
import { computeStabilitySignal } from "./stability.js";
import type { ReplayHistoryEntry } from "./registry.js";

function entry(status: ReplayHistoryEntry["status"], runId = "r"): ReplayHistoryEntry {
  return { runId, timestamp: "2026-01-01T00:00:00.000Z", status };
}

describe("computeStabilitySignal", () => {
  it("reports unhealthy (not just 'unproven') when there's no history at all", () => {
    const signal = computeStabilitySignal([]);
    expect(signal.healthy).toBe(false);
    expect(signal.recentRuns).toBe(0);
  });

  it("reports healthy when every run in the window is clean", () => {
    const signal = computeStabilitySignal([entry("success"), entry("business_outcome"), entry("success")]);
    expect(signal.healthy).toBe(true);
    expect(signal.isFlaky).toBe(false);
  });

  it("reports unhealthy and NOT flaky when every recent run failed", () => {
    const signal = computeStabilitySignal([entry("failure"), entry("failure"), entry("failure")]);
    expect(signal.healthy).toBe(false);
    expect(signal.isFlaky).toBe(false); // uniformly broken is not "flaky" -- flaky means mixed
  });

  it("reports flaky when the recent window mixes clean and failing runs", () => {
    const signal = computeStabilitySignal([entry("success"), entry("failure"), entry("success"), entry("failure")]);
    expect(signal.isFlaky).toBe(true);
    expect(signal.healthy).toBe(false);
  });

  it("only considers the most recent windowSize runs, not the full history", () => {
    const history = [entry("failure"), entry("failure"), entry("failure"), entry("success"), entry("success")];
    const signal = computeStabilitySignal(history, 2);
    expect(signal.recentRuns).toBe(2);
    expect(signal.healthy).toBe(true); // the two most recent are both clean, even though earlier ones failed
  });

  it("flags justDegraded when the single most recent run failed right after a clean one", () => {
    const signal = computeStabilitySignal([entry("success"), entry("success"), entry("failure")]);
    expect(signal.justDegraded).toBe(true);
  });

  it("does not flag justDegraded when the most recent failure follows an earlier failure (already known, not new)", () => {
    const signal = computeStabilitySignal([entry("success"), entry("failure"), entry("failure")]);
    expect(signal.justDegraded).toBe(false);
  });

  it("does not flag justDegraded with fewer than two runs in the window", () => {
    expect(computeStabilitySignal([entry("failure")]).justDegraded).toBe(false);
  });
});
