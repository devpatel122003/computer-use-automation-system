import { describe, expect, it } from "vitest";
import { aggregateRunMetrics, computeRunMetrics, formatDuration, formatSpeedup } from "./metrics.js";
import type { LogEvent } from "../evidence/logger.js";

function evt(ts: string, phase: LogEvent["phase"]): LogEvent {
  return { ts, step: 1, phase, summary: "x" };
}

describe("computeRunMetrics", () => {
  it("returns null for an empty log", () => {
    expect(computeRunMetrics("run-1", [])).toBeNull();
  });

  it("computes duration from first to last event and counts decide phases", () => {
    const events = [
      evt("2026-01-01T00:00:00.000Z", "start"),
      evt("2026-01-01T00:00:01.000Z", "decide"),
      evt("2026-01-01T00:00:02.000Z", "decide"),
      evt("2026-01-01T00:00:04.500Z", "end"),
    ];
    const result = computeRunMetrics("run-1", events);
    expect(result).toEqual({ runId: "run-1", durationMs: 4500, llmCalls: 2 });
  });

  it("never returns a negative duration even if timestamps are out of order", () => {
    const events = [evt("2026-01-01T00:00:05.000Z", "start"), evt("2026-01-01T00:00:00.000Z", "end")];
    expect(computeRunMetrics("run-1", events)?.durationMs).toBe(0);
  });
});

describe("aggregateRunMetrics", () => {
  it("returns null for an empty list", () => {
    expect(aggregateRunMetrics([])).toBeNull();
  });

  it("averages duration and llm calls across runs", () => {
    const runs = [
      { runId: "a", durationMs: 1000, llmCalls: 4 },
      { runId: "b", durationMs: 3000, llmCalls: 6 },
    ];
    expect(aggregateRunMetrics(runs)).toEqual({ runCount: 2, avgDurationMs: 2000, avgLlmCalls: 5 });
  });
});

describe("formatDuration", () => {
  it("formats sub-second durations in ms", () => {
    expect(formatDuration(420)).toBe("420ms");
  });

  it("formats durations >= 1s with one decimal", () => {
    expect(formatDuration(4200)).toBe("4.2s");
  });
});

describe("formatSpeedup", () => {
  it("computes the discovery/replay ratio", () => {
    expect(formatSpeedup(8000, 2000)).toBe("4.0x");
  });

  it("returns null when either side has no data", () => {
    expect(formatSpeedup(0, 2000)).toBeNull();
    expect(formatSpeedup(8000, 0)).toBeNull();
  });
});
