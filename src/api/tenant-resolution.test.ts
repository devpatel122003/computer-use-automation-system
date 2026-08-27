import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEffectiveArtifact } from "./tenant-resolution.js";
import { baseArtifact } from "../test-support/fixtures.js";

function tempOverridesDir(): string {
  const dir = path.join(os.tmpdir(), `tenant-overrides-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolveEffectiveArtifact", () => {
  it("returns the base artifact unchanged when no tenantId is given", () => {
    const artifact = baseArtifact();
    expect(resolveEffectiveArtifact(artifact, undefined, tempOverridesDir())).toBe(artifact);
  });

  it("loads <tenantId>.json and applies it", () => {
    const dir = tempOverridesDir();
    fs.writeFileSync(
      path.join(dir, "northgate-cu.json"),
      JSON.stringify({
        tenantId: "northgate-cu",
        vendorProductId: "mock-bank",
        locatorOverrides: [{ stepId: "step-4", strategy: "role", name: "Log In" }],
        checkpointOverrides: [],
      })
    );
    const effective = resolveEffectiveArtifact(baseArtifact(), "northgate-cu", dir);
    expect(effective.steps[0]?.locator?.[0]?.name).toBe("Log In");
  });

  it("throws when no override file exists for the requested tenantId", () => {
    const dir = tempOverridesDir();
    expect(() => resolveEffectiveArtifact(baseArtifact(), "no-such-tenant", dir)).toThrow(/no-such-tenant/);
  });

  it("throws when the override file's declared tenantId doesn't match the requested one", () => {
    const dir = tempOverridesDir();
    fs.writeFileSync(
      path.join(dir, "requested-tenant.json"),
      JSON.stringify({ tenantId: "a-different-tenant", vendorProductId: "mock-bank", locatorOverrides: [], checkpointOverrides: [] })
    );
    expect(() => resolveEffectiveArtifact(baseArtifact(), "requested-tenant", dir)).toThrow(/mismatched override/i);
  });

  it("rejects a path-traversal tenantId before ever touching the filesystem, instead of leaking a file-not-found for the resolved path", () => {
    const dir = tempOverridesDir();
    // If this ever built a path via naive `path.join`, this would resolve outside `dir`
    // entirely -- e.g. up to a real .env or package.json elsewhere on disk. Asserting the
    // *validation* error message (not a generic ENOENT) proves the check runs before any
    // fs access, not just that the traversal happens to fail for an unrelated reason.
    expect(() => resolveEffectiveArtifact(baseArtifact(), "../../../../etc/passwd", dir)).toThrow(/Invalid tenantId/);
  });

  it("rejects a tenantId containing a path separator even without '..' segments", () => {
    const dir = tempOverridesDir();
    expect(() => resolveEffectiveArtifact(baseArtifact(), "sub/dir", dir)).toThrow(/Invalid tenantId/);
  });

  it("accepts a tenantId with hyphens and underscores, the same charset real tenant files use", () => {
    const dir = tempOverridesDir();
    fs.writeFileSync(
      path.join(dir, "north_gate-cu.json"),
      JSON.stringify({ tenantId: "north_gate-cu", vendorProductId: "mock-bank", locatorOverrides: [], checkpointOverrides: [] })
    );
    expect(() => resolveEffectiveArtifact(baseArtifact(), "north_gate-cu", dir)).not.toThrow();
  });
});
