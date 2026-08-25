import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";
import { computeConfidence, fingerprintArtifact, loadRegistry, type ApprovalState, type ConfidenceScore } from "./registry.js";
import { applyTenantOverride, TenantOverrideSchema } from "./tenant-override.js";

/**
 * One place that turns "whatever *.artifact.json files are on disk" into "capabilities with
 * their current trust state" -- shared by the dashboard (src/dashboard) and the capability
 * API (src/api), so there's exactly one implementation of "load an artifact and look up its
 * registry entry" rather than two that could quietly drift apart.
 */

export interface CapabilityCatalogEntry {
  artifact: CapabilityArtifact;
  fingerprint: string;
  approvalState: ApprovalState;
  confidence: ConfidenceScore;
}

function unprovenConfidence(): ConfidenceScore {
  return { totalRuns: 0, successCount: 0, hardFailureCount: 0, score: 0, label: "unproven" };
}

export function loadCapabilityCatalog(
  artifactsDir = "evidence/artifacts",
  registryPath: string = path.join(artifactsDir, "registry.json")
): CapabilityCatalogEntry[] {
  if (!fs.existsSync(artifactsDir)) return [];
  const registry = loadRegistry(registryPath);

  return fs
    .readdirSync(artifactsDir)
    .filter((f) => f.endsWith(".artifact.json"))
    .map((file) => {
      const raw = JSON.parse(fs.readFileSync(path.join(artifactsDir, file), "utf-8"));
      const artifact = CapabilityArtifactSchema.parse(raw);
      const fingerprint = fingerprintArtifact(artifact);
      const entry = registry[`${artifact.id}@${fingerprint}`];
      return {
        artifact,
        fingerprint,
        approvalState: entry?.approvalState ?? "draft",
        confidence: entry ? computeConfidence(entry) : unprovenConfidence(),
      } satisfies CapabilityCatalogEntry;
    });
}

/** First catalog entry matching a capability id. Artifacts are looked up by `id`, not
 *  fingerprint -- if this repo ever had two on-disk versions of the same capability id,
 *  this takes whichever `fs.readdirSync` happens to return first, which is a real
 *  limitation for a fleet, not a bug at this repo's current one-file-per-id scale. */
export function findCapabilityById(id: string, artifactsDir = "evidence/artifacts"): CapabilityCatalogEntry | undefined {
  return loadCapabilityCatalog(artifactsDir).find((entry) => entry.artifact.id === id);
}

export interface TenantVariantEntry {
  tenantId: string;
  artifact: CapabilityArtifact;
  fingerprint: string;
  approvalState: ApprovalState;
  confidence: ConfidenceScore;
}

/**
 * A tenant override (src/artifact/tenant-override.ts) never exists as a file under
 * evidence/artifacts/ -- it's computed in memory at replay/invoke time -- so without this,
 * a tenant variant that's been approved and replayed for real (see REPORT.md "Stretch
 * goals") was invisible to anything that only reads *.artifact.json files, including the
 * dashboard. This reconstructs each variant's current trust state the same way
 * `resolveEffectiveArtifact` (src/api/tenant-resolution.ts) does at request time, just for
 * every override file instead of one named tenantId.
 */
export function loadTenantVariants(
  baseArtifact: CapabilityArtifact,
  overridesDir = "config/tenant-overrides",
  registryPath = "evidence/artifacts/registry.json"
): TenantVariantEntry[] {
  if (!fs.existsSync(overridesDir)) return [];
  const registry = loadRegistry(registryPath);

  return fs
    .readdirSync(overridesDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_")) // "_"-prefixed = a fixture, not a real tenant -- see _negative-control-url-only.json
    .flatMap((file) => {
      const parsed = TenantOverrideSchema.safeParse(JSON.parse(fs.readFileSync(path.join(overridesDir, file), "utf-8")));
      if (!parsed.success || parsed.data.vendorProductId !== baseArtifact.target.appId) return [];

      const artifact = applyTenantOverride(baseArtifact, parsed.data);
      const fingerprint = fingerprintArtifact(artifact);
      const entry = registry[`${artifact.id}@${fingerprint}`];
      return [
        {
          tenantId: parsed.data.tenantId,
          artifact,
          fingerprint,
          approvalState: entry?.approvalState ?? "draft",
          confidence: entry ? computeConfidence(entry) : unprovenConfidence(),
        } satisfies TenantVariantEntry,
      ];
    });
}
