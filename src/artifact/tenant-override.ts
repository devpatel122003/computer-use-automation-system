import { z } from "zod";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

/**
 * Cross-tenant reuse (brief §8 "Canonicalization / cross-tenant reuse", REPORT.md §4's
 * "override layer" design, now built rather than only described): the same recorded
 * artifact, applied to a second tenant running the identical underlying vendor product
 * but branded/configured differently, via a small named patch -- not a re-recording.
 *
 * Deliberately narrow in what it's allowed to touch: a locator candidate's `name` (the
 * accessible name/visible text a rebranded control now uses) and a checkpoint/known-outcome
 * detector's `expr` (the copy that changed). It cannot add/remove steps, change action
 * types, or touch input/output contracts -- an override describes "this tenant's UI says
 * different words for the same flow," not "this tenant's flow is different," which would
 * need its own recording instead.
 */

export const LocatorOverrideSchema = z.object({
  stepId: z.string(),
  /** Which locator candidate on that step to patch -- "role" (accessible name) or "text"
   *  (exact visible-text match). css_structural/test_id are deliberately not overridable
   *  here: a structural fallback that still happens to resolve on the variant is a
   *  property of *that* tenant's markup, not something a copy-only override should assert. */
  strategy: z.enum(["role", "text"]),
  name: z.string(),
});
export type LocatorOverride = z.infer<typeof LocatorOverrideSchema>;

export const CheckpointOverrideSchema = z.object({
  /** "success" for the artifact's successCheckpoint, or a knownOutcomes[].name. */
  target: z.string(),
  expr: z.string(),
});
export type CheckpointOverride = z.infer<typeof CheckpointOverrideSchema>;

export const TenantOverrideSchema = z.object({
  tenantId: z.string(),
  /** Must match the base artifact's target.appId -- an override authored for one vendor
   *  product must never be silently applied to a different one. */
  vendorProductId: z.string(),
  /** This tenant's own deployment URL, if it differs from the base artifact's. */
  baseUrlPattern: z.string().optional(),
  locatorOverrides: z.array(LocatorOverrideSchema).default([]),
  checkpointOverrides: z.array(CheckpointOverrideSchema).default([]),
});
export type TenantOverride = z.infer<typeof TenantOverrideSchema>;

/**
 * Applies a tenant override to a base artifact, returning a new, independently-valid
 * artifact -- the base artifact object passed in is never mutated. Fails loudly (throws)
 * on any override entry that doesn't match something real in the base artifact: a
 * hand-authored override referencing a stepId, strategy, or knownOutcome name that no
 * longer exists is a config bug that should block replay, not silently no-op and leave
 * the *old* branding's locator in place against the *new* tenant's page.
 */
export function applyTenantOverride(artifact: CapabilityArtifact, override: TenantOverride): CapabilityArtifact {
  if (override.vendorProductId !== artifact.target.appId) {
    throw new Error(
      `Tenant override "${override.tenantId}" targets vendor product "${override.vendorProductId}", but this artifact's target.appId is "${artifact.target.appId}".`
    );
  }

  const patched: CapabilityArtifact = structuredClone(artifact);

  if (override.baseUrlPattern) {
    patched.target.baseUrlPattern = override.baseUrlPattern;
  }

  for (const loc of override.locatorOverrides) {
    const step = patched.steps.find((s) => s.id === loc.stepId);
    if (!step) {
      throw new Error(`Tenant override "${override.tenantId}": step "${loc.stepId}" does not exist in this artifact.`);
    }
    const candidate = step.locator?.find((c) => c.strategy === loc.strategy);
    if (!candidate) {
      throw new Error(
        `Tenant override "${override.tenantId}": step "${loc.stepId}" has no "${loc.strategy}" locator candidate to patch.`
      );
    }
    candidate.name = loc.name;
  }

  for (const cp of override.checkpointOverrides) {
    if (cp.target === "success") {
      patched.successCheckpoint.expr = cp.expr;
      continue;
    }
    const outcome = patched.knownOutcomes.find((o) => o.name === cp.target);
    if (!outcome) {
      throw new Error(`Tenant override "${override.tenantId}": known outcome "${cp.target}" does not exist in this artifact.`);
    }
    outcome.detector.expr = cp.expr;
  }

  // Validate what we just produced, not just what was loaded from disk -- the same
  // discipline the recorder applies to its own output (src/artifact/recorder.ts): a
  // hand-authored override that (say) left a step's locator array in a broken state
  // should fail here, not three steps into an unattended replay.
  return CapabilityArtifactSchema.parse(patched);
}
