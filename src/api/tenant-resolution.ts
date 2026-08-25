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

// tenantId reaches here straight from an HTTP request body (or, via the conversational
// front end, from a model's own output) -- an untrusted caller, not an operator typing a
// CLI flag. Without this check, `path.join(overridesDir, \`${tenantId}.json\`)` below is a
// real path-traversal read: a tenantId of "../../../../etc/passwd\0" (or, more realistically
// reachable without a null byte, "../../../some/other/config") would let a caller read any
// *.json file on disk the process can access, not just a tenant override. Restricting to the
// same charset filenames on disk actually use closes that off before any path is built.
const SAFE_TENANT_ID = /^[a-zA-Z0-9_-]+$/;

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
  if (!SAFE_TENANT_ID.test(tenantId)) {
    throw new Error(`Invalid tenantId "${tenantId}" -- must match ${SAFE_TENANT_ID}.`);
  }

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
