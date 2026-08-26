import type { CapabilityArtifact } from "../artifact/schema.js";
import type { LocatorOverride, TenantOverride } from "../artifact/tenant-override.js";
import type { StepDriftReport } from "./drift.js";

/**
 * Closes the loop between UI drift detection (drift.ts/drift-report) and cross-tenant
 * reuse (tenant-override.ts): instead of a human re-deriving "which steps need an override"
 * from a drift report by hand, this generates the override's SHAPE automatically -- which
 * steps, which strategy slot -- while leaving the actual corrected `name` as an explicit
 * TODO. Deliberately not a guess: a drift report only records which locator STRATEGY won
 * (a count per strategy type), never the actual accessible name/text that resolved, so
 * there is no honest way to fabricate a replacement value without a live look at the page.
 * This is the same "propose, a human reviews and approves, nothing is auto-applied" posture
 * approve.ts already uses for artifact/override approval -- just one step earlier, at
 * "what needs attention" rather than "is this trustworthy yet."
 */

/** Non-extract steps with real drift. `extract` steps are excluded for the same reason
 *  driftAdjustedLabel() already excludes them (drift.ts): their locator often targets a
 *  literal value captured at recording time (e.g. a confirmation number), which by
 *  construction never matches again -- a permanent, harmless false positive, not a real
 *  copy-changed-on-this-tenant signal worth proposing a fix for. */
export function stepsNeedingOverride(reports: StepDriftReport[]): StepDriftReport[] {
  return reports.filter((r) => r.actionType !== "extract" && r.driftCount > 0);
}

const OVERRIDABLE_STRATEGIES = new Set<StepDriftReport["expectedStrategy"]>(["role", "text"]);

/**
 * Builds a draft TenantOverride scaffold: one LocatorOverride per drifting, overridable
 * step, with `name` left as an explicit TODO for a human to fill in after looking at the
 * tenant's live page. Steps whose expected strategy is `css_structural`/`test_id` are
 * skipped entirely -- LocatorOverrideSchema only allows patching `role`/`text` (see
 * tenant-override.ts's own comment: a structural match is a property of that tenant's
 * markup, not something a copy-only override should assert), so there is no override this
 * function could honestly propose for those steps.
 */
export function buildOverrideScaffold(
  artifact: CapabilityArtifact,
  reports: StepDriftReport[],
  tenantId: string,
  vendorProductId: string = artifact.target.appId
): TenantOverride {
  const locatorOverrides: LocatorOverride[] = stepsNeedingOverride(reports)
    .filter((r) => OVERRIDABLE_STRATEGIES.has(r.expectedStrategy))
    .map((r) => ({
      stepId: r.stepId,
      strategy: r.expectedStrategy as "role" | "text",
      name: `TODO: inspect tenant "${tenantId}"'s live page for step "${r.stepId}" (${r.description}) and supply the current accessible name/text here`,
    }));

  return {
    tenantId,
    vendorProductId,
    locatorOverrides,
    checkpointOverrides: [],
  };
}
