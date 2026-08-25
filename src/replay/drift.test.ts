import { describe, expect, it } from "vitest";
import { driftAdjustedLabel, extractStepMatches, summarizeDrift, type StepDriftReport } from "./drift.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../artifact/schema.js";
import type { LogEvent } from "../evidence/logger.js";

function artifactWithTwoClickSteps(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    id: "test-capability",
    name: "Test",
    description: "test",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    target: { appId: "test-app", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputSchema: [],
    steps: [
      { id: "step-1", actionType: "navigate", description: "Navigate to /login", url: "/login", risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 } },
      {
        id: "step-2",
        actionType: "click",
        description: 'Click button "Sign On"',
        locator: [
          { strategy: "role", role: "button", name: "Sign On", nth: 0, confidence: "high", rationale: "r" },
          { strategy: "text", name: "Sign On", nth: 0, confidence: "medium", rationale: "r" },
        ],
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
      {
        id: "step-3",
        actionType: "click",
        description: 'Click link "Open"',
        locator: [{ strategy: "role", role: "link", name: "Open", nth: 0, confidence: "high", rationale: "r" }],
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
    ],
    successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
    knownOutcomes: [],
  });
}

function actEvent(step: number, matchedStrategy: string | undefined): LogEvent {
  return {
    ts: new Date().toISOString(),
    step,
    phase: "act",
    summary: "performed",
    detail: { action: { type: "click" }, result: { ok: true, matchedStrategy } },
  };
}

describe("extractStepMatches", () => {
  it("extracts matched strategies from main-loop act events only", () => {
    const events: LogEvent[] = [
      actEvent(2, "role"),
      actEvent(3, "role"),
      // Recovery re-run shape: step 0, no top-level `action` key -- must be excluded.
      { ts: new Date().toISOString(), step: 0, phase: "act", summary: "recovery", detail: { stepId: "step-2", result: { ok: true, matchedStrategy: "role" } } },
      // No matchedStrategy (e.g. a navigate) -- excluded.
      { ts: new Date().toISOString(), step: 1, phase: "act", summary: "nav", detail: { action: { type: "navigate" }, result: { ok: true } } },
    ];
    const matches = extractStepMatches(events);
    expect(matches).toEqual([
      { stepNum: 2, matchedStrategy: "role" },
      { stepNum: 3, matchedStrategy: "role" },
    ]);
  });
});

describe("summarizeDrift", () => {
  it("reports no drift when every run resolves via the step's top-priority candidate", () => {
    const artifact = artifactWithTwoClickSteps();
    const matches = [
      { stepNum: 2, matchedStrategy: "role" as const },
      { stepNum: 2, matchedStrategy: "role" as const },
      { stepNum: 3, matchedStrategy: "role" as const },
    ];
    const report = summarizeDrift(artifact, matches);
    expect(report).toHaveLength(2);
    const step2 = report.find((r) => r.stepId === "step-2")!;
    expect(step2.expectedStrategy).toBe("role");
    expect(step2.driftCount).toBe(0);
    expect(step2.totalObservations).toBe(2);
  });

  it("flags a step that falls back to a lower-confidence strategy", () => {
    const artifact = artifactWithTwoClickSteps();
    const matches = [
      { stepNum: 2, matchedStrategy: "role" as const },
      { stepNum: 2, matchedStrategy: "text" as const },
      { stepNum: 2, matchedStrategy: "text" as const },
    ];
    const report = summarizeDrift(artifact, matches);
    const step2 = report.find((r) => r.stepId === "step-2")!;
    expect(step2.observedCounts).toEqual({ role: 1, text: 2 });
    expect(step2.driftCount).toBe(2);
    expect(step2.totalObservations).toBe(3);
  });

  it("omits steps with no observations and steps with no locator (navigate)", () => {
    const artifact = artifactWithTwoClickSteps();
    const report = summarizeDrift(artifact, [{ stepNum: 2, matchedStrategy: "role" as const }]);
    expect(report).toHaveLength(1);
    expect(report[0]?.stepId).toBe("step-2");
  });
});

function driftReport(driftCount: number): StepDriftReport {
  return { stepId: "step-2", description: "d", expectedStrategy: "role", observedCounts: {}, totalObservations: 1, driftCount };
}

describe("driftAdjustedLabel", () => {
  it("leaves the label unchanged when no step shows drift", () => {
    expect(driftAdjustedLabel("high", [driftReport(0), driftReport(0)])).toBe("high");
  });

  it("leaves the label unchanged when there is no drift data at all", () => {
    expect(driftAdjustedLabel("high", [])).toBe("high");
  });

  it("caps high down to medium when any step shows drift", () => {
    expect(driftAdjustedLabel("high", [driftReport(0), driftReport(2)])).toBe("medium");
  });

  it("caps medium down to low", () => {
    expect(driftAdjustedLabel("medium", [driftReport(1)])).toBe("low");
  });

  it("leaves low and unproven as themselves -- there's nowhere lower to cap them", () => {
    expect(driftAdjustedLabel("low", [driftReport(1)])).toBe("low");
    expect(driftAdjustedLabel("unproven", [driftReport(1)])).toBe("unproven");
  });
});
