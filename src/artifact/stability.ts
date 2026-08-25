import type { ReplayHistoryEntry } from "./registry.js";

/**
 * Brief §8 "Multi-run stability": replay N times and report a stability/flakiness signal.
 * Deliberately built on top of the confidence registry's existing history rather than a
 * second data store -- `computeConfidence()` (registry.ts) answers "has this artifact
 * generally worked"; this answers a narrower, more operational question over the *recent*
 * window specifically: "is it healthy right now, and did it just change." The two are
 * related but different: an artifact with a lifetime score of 90% that just failed its
 * last three runs in a row is still "generally reliable" by the lifetime number, but that's
 * exactly the moment an on-call human wants to hear about it.
 */

export interface StabilitySignal {
  windowSize: number;
  /** How many runs actually exist in the window -- may be less than windowSize early on. */
  recentRuns: number;
  recentCleanCount: number;
  recentFailureCount: number;
  /** Mixed clean/failure outcomes within the recent window -- neither uniformly healthy
   *  nor uniformly broken, the signature of something intermittent rather than solidly
   *  working or solidly down. */
  isFlaky: boolean;
  /** The single most recent run failed, but the run immediately before it didn't --
   *  worth flagging distinctly from "has been failing for a while," since it's the moment
   *  something just changed, not an already-known problem. */
  justDegraded: boolean;
  /** false if there's no history at all yet -- "healthy" would overclaim confidence for
   *  content that's never actually been run. */
  healthy: boolean;
}

export function computeStabilitySignal(history: ReplayHistoryEntry[], windowSize = 5): StabilitySignal {
  const recent = history.slice(-windowSize);
  const isClean = (h: ReplayHistoryEntry) => h.status === "success" || h.status === "business_outcome";

  const recentCleanCount = recent.filter(isClean).length;
  const recentFailureCount = recent.length - recentCleanCount;
  const isFlaky = recentCleanCount > 0 && recentFailureCount > 0;

  const last = recent[recent.length - 1];
  const secondLast = recent[recent.length - 2];
  const justDegraded = recent.length >= 2 && last !== undefined && secondLast !== undefined && !isClean(last) && isClean(secondLast);

  return {
    windowSize,
    recentRuns: recent.length,
    recentCleanCount,
    recentFailureCount,
    isFlaky,
    justDegraded,
    healthy: recent.length > 0 && recentFailureCount === 0,
  };
}
