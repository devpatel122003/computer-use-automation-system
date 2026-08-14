import { describe, expect, it } from "vitest";
import { CapabilityArtifactSchema } from "./schema.js";

function baseArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "cap",
    name: "Cap",
    description: "d",
    version: "1.0.0",
    createdAt: "2026-01-01T00:00:00.000Z",
    target: { appId: "app", surfaceType: "web", baseUrlPattern: "http://x" },
    inputParams: [{ name: "memberId", type: "string", required: true, sensitive: false }],
    outputSchema: [],
    steps: [
      { id: "step-1", actionType: "navigate", description: "nav", url: "/x", risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 } },
      {
        id: "step-2",
        actionType: "type",
        description: "type",
        locator: [{ strategy: "text", name: "Field", nth: 0, confidence: "medium", rationale: "" }],
        input: { paramRef: "memberId" },
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
    ],
    successCheckpoint: { kind: "text_match", expr: "ok", description: "" },
    knownOutcomes: [],
    ...overrides,
  };
}

describe("CapabilityArtifactSchema cross-field validation", () => {
  it("accepts a well-formed artifact", () => {
    expect(CapabilityArtifactSchema.safeParse(baseArtifact()).success).toBe(true);
  });

  it("rejects a step whose paramRef references an undeclared input param", () => {
    const artifact = baseArtifact({
      steps: [
        {
          id: "step-1",
          actionType: "type",
          description: "type",
          locator: [{ strategy: "text", name: "Field", nth: 0, confidence: "medium", rationale: "" }],
          input: { paramRef: "typoedName" },
          risk: "safe",
          waitPolicy: { timeoutMs: 5000, retries: 0 },
        },
      ],
    });
    const result = CapabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
  });

  it("rejects outputName set on a non-extract step", () => {
    const artifact = baseArtifact({
      steps: [
        {
          id: "step-1",
          actionType: "click",
          description: "click",
          locator: [{ strategy: "text", name: "Button", nth: 0, confidence: "medium", rationale: "" }],
          outputName: "shouldNotBeHere",
          risk: "safe",
          waitPolicy: { timeoutMs: 5000, retries: 0 },
        },
      ],
    });
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects an outputSchema entry whose sourceStepId doesn't exist", () => {
    const artifact = baseArtifact({ outputSchema: [{ name: "x", type: "string", sourceStepId: "step-99" }] });
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects a knownOutcome with recovery fields set but category is not 'recoverable'", () => {
    const artifact = baseArtifact({
      knownOutcomes: [
        {
          name: "oops",
          category: "business_outcome",
          detector: { kind: "text_match", expr: "x", description: "" },
          description: "d",
          recovery: "retry_step",
        },
      ],
    });
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects a recoveryStepIds entry that doesn't reference an existing step", () => {
    const artifact = baseArtifact({
      knownOutcomes: [
        {
          name: "timeout",
          category: "recoverable",
          detector: { kind: "text_match", expr: "expired", description: "" },
          description: "d",
          recovery: "reauthenticate_and_retry_step",
          recoveryStepIds: ["step-1", "step-does-not-exist"],
        },
      ],
    });
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("accepts a well-formed recoverable knownOutcome", () => {
    const artifact = baseArtifact({
      knownOutcomes: [
        {
          name: "timeout",
          category: "recoverable",
          detector: { kind: "text_match", expr: "expired", description: "" },
          description: "d",
          recovery: "reauthenticate_and_retry_step",
          recoveryStepIds: ["step-1"],
        },
      ],
    });
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(true);
  });
});
