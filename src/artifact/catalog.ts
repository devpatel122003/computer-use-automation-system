import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";
import { computeConfidence, fingerprintArtifact, loadRegistry, type ApprovalState, type ConfidenceScore } from "./registry.js";

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
