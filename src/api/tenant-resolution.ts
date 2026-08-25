import fs from "node:fs";
import path from "node:path";
import { applyTenantOverride, TenantOverrideSchema } from "../artifact/tenant-override.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

/**
 * Ties the cross-tenant reuse stretch goal (src/artifact/tenant-override.ts) into the
 * agent-facing capability API: an invocation can ask for a specific tenant's variant of a
 * capability, not just the base artifact. Without this, the two stretch goals didn't talk
 * to each other -- an agent had no way to say "run this for tenant X" over HTTP at all.
 */

export const TENANT_OVERRIDES_DIR = "config/tenant-overrides";

/** Convention: a tenant's override file lives at `<overridesDir>/<tenantId>.json`, and the
 *  file's own declared `tenantId` must match the filename it was requested by -- a
 *  mismatch is refused rather than silently applying whichever override happened to be
 *  found, the same "fail loud on a config mismatch" posture as `applyTenantOverride`'s own
 *  vendorProductId check. */
export function resolveEffectiveArtifact(
  baseArtifact: CapabilityArtifact,
  tenantId: string | undefined,
  overridesDir: string = TENANT_OVERRIDES_DIR
): CapabilityArtifact {
  if (!tenantId) return baseArtifact;

  const overridePath = path.join(overridesDir, `${tenantId}.json`);
  if (!fs.existsSync(overridePath)) {
    throw new Error(`No tenant override found for tenantId "${tenantId}" (expected ${overridePath}).`);
  }

  const raw = JSON.parse(fs.readFileSync(overridePath, "utf-8"));
  const override = TenantOverrideSchema.parse(raw);
  if (override.tenantId !== tenantId) {
    throw new Error(
      `Tenant override file at ${overridePath} declares tenantId "${override.tenantId}", not "${tenantId}" -- refusing a mismatched override.`
    );
  }

  return applyTenantOverride(baseArtifact, override);
}
