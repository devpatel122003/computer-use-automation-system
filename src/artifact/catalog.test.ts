import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTenantVariants } from "./catalog.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

function baseArtifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    id: "open-sub-account",
    name: "Open Sub-Account",
    description: "test",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputSchema: [],
    steps: [
      {
        id: "step-4",
        actionType: "click",
        description: 'Click button "Sign On"',
        locator: [{ strategy: "role", role: "button", name: "Sign On", nth: 0, confidence: "high", rationale: "r" }],
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
    ],
    successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
    knownOutcomes: [],
  });
}

function tempDir(): string {
  const dir = path.join(os.tmpdir(), `catalog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadTenantVariants", () => {
  it("returns an empty list when the overrides directory doesn't exist", () => {
    expect(loadTenantVariants(baseArtifact(), path.join(os.tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  it("loads a matching override and applies it", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "northgate-cu.json"),
      JSON.stringify({
        tenantId: "northgate-cu",
        vendorProductId: "mock-bank",
        locatorOverrides: [{ stepId: "step-4", strategy: "role", name: "Log In" }],
        checkpointOverrides: [],
      })
    );
    const variants = loadTenantVariants(baseArtifact(), dir, path.join(dir, "registry.json"));
    expect(variants).toHaveLength(1);
    expect(variants[0]?.tenantId).toBe("northgate-cu");
    expect(variants[0]?.artifact.steps[0]?.locator?.[0]?.name).toBe("Log In");
    expect(variants[0]?.approvalState).toBe("draft");
    expect(variants[0]?.confidence.label).toBe("unproven");
  });

  it("skips underscore-prefixed fixture files", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "_negative-control-url-only.json"),
      JSON.stringify({ tenantId: "x", vendorProductId: "mock-bank", locatorOverrides: [], checkpointOverrides: [] })
    );
    expect(loadTenantVariants(baseArtifact(), dir, path.join(dir, "registry.json"))).toEqual([]);
  });

  it("skips an override for a different vendor product", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "other-vendor.json"),
      JSON.stringify({ tenantId: "other", vendorProductId: "some-other-app", locatorOverrides: [], checkpointOverrides: [] })
    );
    expect(loadTenantVariants(baseArtifact(), dir, path.join(dir, "registry.json"))).toEqual([]);
  });

  it("skips a file that isn't a valid tenant override rather than throwing", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "garbage.json"), JSON.stringify({ notAnOverride: true }));
    expect(loadTenantVariants(baseArtifact(), dir, path.join(dir, "registry.json"))).toEqual([]);
  });
});
