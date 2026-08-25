import type { ApprovalState } from "../artifact/registry.js";
import type { ConfidenceLabel } from "./drift.js";

/**
 * Confidence stops being informational and becomes something the system obeys. Until now,
 * `approvalState === "approved"` was the only gate on unattended (`--allow-risky`)
 * execution -- an artifact approved once stayed unattended-eligible forever, even if its
 * drift-adjusted confidence (drift.ts) later degrades. This is the missing second gate: an
 * approved artifact still falls back to attended confirmation if its trust has dropped to
 * "low" or "unproven", regardless of what the caller requested. Deliberately conservative
 * and binary -- "medium"/"high" pass, "low"/"unproven" block -- reusing the exact tiers
 * driftAdjustedLabel() already produces rather than inventing a second threshold scale.
 */
export function effectiveAllowRisky(params: {
  requestedAllowRisky: boolean;
  approvalState: ApprovalState;
  driftAdjustedLabel: ConfidenceLabel;
}): boolean {
  if (!params.requestedAllowRisky) return false;
  if (params.approvalState !== "approved") return false;
  return params.driftAdjustedLabel === "medium" || params.driftAdjustedLabel === "high";
}
