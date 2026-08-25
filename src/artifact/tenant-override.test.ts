import { describe, expect, it } from "vitest";
import { applyTenantOverride, TenantOverrideSchema } from "./tenant-override.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

function baseArtifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    id: "open-sub-account",
    name: "Open Sub-Account",
    description: "test",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [{ name: "memberId", type: "string", required: true, sensitive: false }],
    outputSchema: [],
    steps: [
      {
        id: "step-4",
        actionType: "click",
        description: 'Click button "Sign On"',
        locator: [
          { strategy: "role", role: "button", name: "Sign On", nth: 0, confidence: "high", rationale: "r" },
          { strategy: "text", name: "Sign On", nth: 0, confidence: "medium", rationale: "r" },
          { strategy: "css_structural", cssPath: "body > input", nth: 0, confidence: "low", rationale: "r" },
        ],
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
    ],
    successCheckpoint: { kind: "text_match", expr: "Sub-account opened successfully", description: "d" },
    knownOutcomes: [
      {
        name: "member_not_found",
        category: "business_outcome",
        detector: { kind: "text_match", expr: "No member found with ID", description: "d" },
        description: "d",
      },
    ],
  });
}

describe("applyTenantOverride", () => {
  it("patches locator candidate names and checkpoint/detector exprs without mutating the input", () => {
    const artifact = baseArtifact();
    const override = TenantOverrideSchema.parse({
      tenantId: "northgate-cu",
      vendorProductId: "mock-bank",
      baseUrlPattern: "http://localhost:4100",
      locatorOverrides: [
        { stepId: "step-4", strategy: "role", name: "Log In" },
        { stepId: "step-4", strategy: "text", name: "Log In" },
      ],
      checkpointOverrides: [
        { target: "success", expr: "Account opened successfully" },
        { target: "member_not_found", expr: "We could not locate a member" },
      ],
    });

    const patched = applyTenantOverride(artifact, override);

    expect(patched.target.baseUrlPattern).toBe("http://localhost:4100");
    const step = patched.steps.find((s) => s.id === "step-4")!;
    expect(step.locator?.find((c) => c.strategy === "role")?.name).toBe("Log In");
    expect(step.locator?.find((c) => c.strategy === "text")?.name).toBe("Log In");
    // css_structural is untouched -- overrides never patch it (see tenant-override.ts).
    expect(step.locator?.find((c) => c.strategy === "css_structural")?.cssPath).toBe("body > input");
    expect(patched.successCheckpoint.expr).toBe("Account opened successfully");
    expect(patched.knownOutcomes[0]?.detector.expr).toBe("We could not locate a member");

    // The original artifact object is untouched.
    expect(artifact.target.baseUrlPattern).toBe("http://localhost:4000");
    expect(artifact.steps[0]?.locator?.find((c) => c.strategy === "role")?.name).toBe("Sign On");
  });

  it("throws when the override's vendorProductId doesn't match the artifact's appId", () => {
    const artifact = baseArtifact();
    const override = TenantOverrideSchema.parse({
      tenantId: "northgate-cu",
      vendorProductId: "some-other-vendor-app",
      locatorOverrides: [],
      checkpointOverrides: [],
    });
    expect(() => applyTenantOverride(artifact, override)).toThrow(/vendor product/i);
  });

  it("throws when a locator override references a step that doesn't exist", () => {
    const artifact = baseArtifact();
    const override = TenantOverrideSchema.parse({
      tenantId: "northgate-cu",
      vendorProductId: "mock-bank",
      locatorOverrides: [{ stepId: "step-99", strategy: "role", name: "x" }],
      checkpointOverrides: [],
    });
    expect(() => applyTenantOverride(artifact, override)).toThrow(/step-99/);
  });

  it("throws when a locator override references a strategy the step doesn't have", () => {
    const artifact = baseArtifact();
    const override = TenantOverrideSchema.parse({
      tenantId: "northgate-cu",
      vendorProductId: "mock-bank",
      locatorOverrides: [], // placeholder, replaced below
      checkpointOverrides: [],
    });
    override.locatorOverrides.push({ stepId: "step-4", strategy: "role", name: "x" });
    // Remove the role candidate to simulate a step that never had one.
    artifact.steps[0]!.locator = artifact.steps[0]!.locator!.filter((c) => c.strategy !== "role");
    expect(() => applyTenantOverride(artifact, override)).toThrow(/no "role" locator candidate/i);
  });

  it("throws when a checkpoint override references a known outcome that doesn't exist", () => {
    const artifact = baseArtifact();
    const override = TenantOverrideSchema.parse({
      tenantId: "northgate-cu",
      vendorProductId: "mock-bank",
      locatorOverrides: [],
      checkpointOverrides: [{ target: "no_such_outcome", expr: "x" }],
    });
    expect(() => applyTenantOverride(artifact, override)).toThrow(/no_such_outcome/);
  });
});
