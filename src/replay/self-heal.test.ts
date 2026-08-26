import { describe, expect, it } from "vitest";
import { buildOverrideScaffold, stepsNeedingOverride } from "./self-heal.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../artifact/schema.js";
import type { StepDriftReport } from "./drift.js";

function artifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    id: "test-capability",
    name: "Test",
    description: "test",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    target: { appId: "test-app", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputSchema: [],
    steps: [{ id: "step-1", actionType: "navigate", description: "Navigate to /login", url: "/login", risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 } }],
    successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
    knownOutcomes: [],
  });
}

function report(overrides: Partial<StepDriftReport> = {}): StepDriftReport {
  return {
    stepId: "step-2",
    description: 'Click button "Sign On"',
    actionType: "click",
    expectedStrategy: "role",
    observedCounts: { role: 1, text: 2 },
    totalObservations: 3,
    driftCount: 2,
    ...overrides,
  };
}

describe("stepsNeedingOverride", () => {
  it("keeps a non-extract step with real drift", () => {
    expect(stepsNeedingOverride([report()])).toHaveLength(1);
  });

  it("excludes a step with zero drift", () => {
    expect(stepsNeedingOverride([report({ driftCount: 0 })])).toHaveLength(0);
  });

  it("excludes an extract-type step even with drift -- known, harmless false positive (see drift.ts's driftAdjustedLabel)", () => {
    expect(stepsNeedingOverride([report({ actionType: "extract", driftCount: 1 })])).toHaveLength(0);
  });
});

describe("buildOverrideScaffold", () => {
  it("proposes a role/text override with an explicit TODO placeholder, never a fabricated value", () => {
    const scaffold = buildOverrideScaffold(artifact(), [report()], "northgate-cu", "test-app");
    expect(scaffold.tenantId).toBe("northgate-cu");
    expect(scaffold.vendorProductId).toBe("test-app");
    expect(scaffold.locatorOverrides).toHaveLength(1);
    expect(scaffold.locatorOverrides[0]).toMatchObject({ stepId: "step-2", strategy: "role" });
    expect(scaffold.locatorOverrides[0]?.name).toContain("TODO");
    // The placeholder must never accidentally contain one of the actually-observed counts
    // as if it were a real captured value -- it's a prompt for a human, not a guess.
    expect(scaffold.locatorOverrides[0]?.name).not.toMatch(/^\d+$/);
    expect(scaffold.checkpointOverrides).toEqual([]);
  });

  it("defaults vendorProductId from the artifact's own target.appId when not given", () => {
    const scaffold = buildOverrideScaffold(artifact(), [report()], "northgate-cu");
    expect(scaffold.vendorProductId).toBe("test-app");
  });

  it("skips a step whose expected strategy is css_structural or test_id -- LocatorOverrideSchema only allows role/text", () => {
    const scaffold = buildOverrideScaffold(artifact(), [report({ expectedStrategy: "css_structural" }), report({ stepId: "step-3", expectedStrategy: "test_id" })], "northgate-cu", "test-app");
    expect(scaffold.locatorOverrides).toHaveLength(0);
  });

  it("proposes nothing when no step needs an override", () => {
    const scaffold = buildOverrideScaffold(artifact(), [report({ driftCount: 0 })], "northgate-cu", "test-app");
    expect(scaffold.locatorOverrides).toHaveLength(0);
  });
});
