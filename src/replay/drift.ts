import type { CapabilityArtifact } from "../artifact/schema.js";
import type { LocatorStrategy } from "../surface/types.js";
import type { LogEvent } from "../evidence/logger.js";

/**
 * UI-drift signal (REPORT.md §3/§4: "the schema already carries what's needed; only the
 * diffing/reporting layer is unbuilt" -- this is that layer). Every replay already logs
 * which locator strategy actually matched per step (`ActionResult.matchedStrategy`); this
 * module diffs that against the step's own highest-priority candidate (the one discovery
 * judged most robust when it was recorded) across however many runs are fed in. A step that
 * keeps resolving via a lower-confidence fallback is exactly the fleet-level review signal
 * §4 describes ("artifact X, tenant Y, step 6: css_structural instead of role, 3 days
 * running") -- aggregated here per-artifact; per-tenant aggregation is the same idea applied
 * to more input, not a different mechanism.
 */

export interface StepDriftReport {
  stepId: string;
  description: string;
  /** The step's own top-priority locator candidate at record time -- not necessarily what
   *  resolved on any given run. */
  expectedStrategy: LocatorStrategy;
  observedCounts: Partial<Record<LocatorStrategy, number>>;
  totalObservations: number;
  /** Observations where the matched strategy was NOT the expected one. */
  driftCount: number;
}

/**
 * Pulls (stepNum, matchedStrategy) pairs out of one run's parsed log events. Only main-loop
 * step executions count -- each carries `detail.action` alongside `detail.result`. Recovery
 * re-runs are logged separately under `step: 0` with a `{ stepId, result }` shape (see
 * replay-engine.ts's `runRecoverySteps`) and are deliberately excluded: a step resolving
 * differently *during recovery* (e.g. re-login after a session timeout) is a different signal
 * than the step's normal first-attempt resolution drifting, and conflating them would make
 * "step X drifted" ambiguous about which invocation actually drifted.
 */
export function extractStepMatches(events: LogEvent[]): Array<{ stepNum: number; matchedStrategy: LocatorStrategy }> {
  const out: Array<{ stepNum: number; matchedStrategy: LocatorStrategy }> = [];
  for (const e of events) {
    if (e.phase !== "act" || e.step <= 0) continue;
    const detail = e.detail as { action?: unknown; result?: { matchedStrategy?: LocatorStrategy } } | undefined;
    if (!detail?.action || !detail.result?.matchedStrategy) continue;
    out.push({ stepNum: e.step, matchedStrategy: detail.result.matchedStrategy });
  }
  return out;
}

/** Builds one drift report per step that has a locator (navigate steps don't) and at least
 *  one observation. `matches` may span many runs -- stepNum (1-indexed position in
 *  artifact.steps) is how they're mapped back to a step id, since the log only records the
 *  numeric position, not the step id itself. */
export function summarizeDrift(
  artifact: CapabilityArtifact,
  matches: Array<{ stepNum: number; matchedStrategy: LocatorStrategy }>
): StepDriftReport[] {
  const reports = new Map<number, StepDriftReport>();

  artifact.steps.forEach((step, index) => {
    const topCandidate = step.locator?.[0];
    if (!topCandidate) return;
    reports.set(index + 1, {
      stepId: step.id,
      description: step.description,
      expectedStrategy: topCandidate.strategy,
      observedCounts: {},
      totalObservations: 0,
      driftCount: 0,
    });
  });

  for (const { stepNum, matchedStrategy } of matches) {
    const report = reports.get(stepNum);
    if (!report) continue;
    report.observedCounts[matchedStrategy] = (report.observedCounts[matchedStrategy] ?? 0) + 1;
    report.totalObservations += 1;
    if (matchedStrategy !== report.expectedStrategy) report.driftCount += 1;
  }

  return Array.from(reports.values()).filter((r) => r.totalObservations > 0);
}

export type ConfidenceLabel = "unproven" | "low" | "medium" | "high";

const LABEL_DOWNGRADE: Record<ConfidenceLabel, ConfidenceLabel> = {
  high: "medium",
  medium: "low",
  low: "low",
  unproven: "unproven",
};

/**
 * REPORT.md's own "what I'd build next": a step that keeps falling back to a lower-
 * confidence locator strategy should pull an artifact's trust down even while it's still
 * technically succeeding. Deliberately NOT folded into `computeConfidence()`'s numeric
 * score itself (registry.ts) -- "did the replay engine correctly explain what happened"
 * and "is a step quietly relying on a fallback" are two honestly separate signals, and
 * blending them into one number would hide which one moved. This caps the *displayed*
 * label one tier down when any step shows drift; the underlying success/business_outcome
 * ratio is untouched and still available for anyone who wants the raw number.
 */
export function driftAdjustedLabel(rawLabel: ConfidenceLabel, drift: StepDriftReport[]): ConfidenceLabel {
  const hasDrift = drift.some((r) => r.driftCount > 0);
  return hasDrift ? LABEL_DOWNGRADE[rawLabel] : rawLabel;
}
