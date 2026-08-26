import fs from "node:fs";
import path from "node:path";

/**
 * Trend-based canary alerting, on top of the existing "last 5 runs" stability signal
 * (stability.ts). `computeStabilitySignal` answers "how do the last few runs of ANY kind
 * look" from the registry's shared replay history (mixed together: CLI replay, capability
 * API invocations, canary-check itself) -- it has no memory between separate canary-check
 * invocations, and no notion of calendar time. This module is a small, dedicated,
 * append-only log of canary-check's OWN invocations specifically, so "has the *scheduled
 * health check* been regressing over its last several runs" is answerable on its own terms,
 * not conflated with unrelated manual replay/invoke traffic against the same artifact.
 */

export interface CanaryCheckRecord {
  timestamp: string;
  artifactId: string;
  fingerprint: string;
  status: "success" | "business_outcome" | "failure";
}

/** How many consecutive non-clean checks in a row count as "regressing," not just "one bad
 *  run" -- distinguishing a transient blip from a real, sustained health decline. */
const REGRESSION_THRESHOLD = 3;

/** Mirrors registry.ts's save pattern (mkdir + write), but appends one JSONL line rather
 *  than rewriting a whole JSON document -- canary-check runs on a schedule and each
 *  invocation should only ever need to add its own record, never re-read-and-rewrite the
 *  entire history just to record one more entry. */
export function appendCanaryRecord(historyPath: string, record: CanaryCheckRecord): void {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
}

/** A missing or corrupt history file behaves like `loadRegistry`'s existing pattern:
 *  treated as empty, never a crash -- a canary that can't read its own trend history should
 *  still complete this run's own health check rather than fail outright over unrelated
 *  history-file trouble. Malformed individual lines are skipped, not fatal to the rest. */
export function loadCanaryHistory(historyPath: string, artifactId: string, fingerprint: string): CanaryCheckRecord[] {
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, "utf-8").split("\n").filter(Boolean);
  const records: CanaryCheckRecord[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as CanaryCheckRecord;
      if (record.artifactId === artifactId && record.fingerprint === fingerprint) records.push(record);
    } catch {
      // A truncated last line (e.g. a killed process mid-append) shouldn't invalidate every
      // earlier, well-formed record -- skip it and keep going.
    }
  }
  return records;
}

export interface CanaryTrend {
  totalChecks: number;
  /** Back-to-back non-clean ("failure") checks ending at the most recent one -- resets to 0
   *  the moment a clean check breaks the streak, so a recovery is reflected immediately. */
  consecutiveUnhealthy: number;
  isRegressing: boolean;
}

export function computeCanaryTrend(history: CanaryCheckRecord[]): CanaryTrend {
  const isClean = (r: CanaryCheckRecord) => r.status === "success" || r.status === "business_outcome";

  let consecutiveUnhealthy = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (isClean(history[i]!)) break;
    consecutiveUnhealthy += 1;
  }

  return {
    totalChecks: history.length,
    consecutiveUnhealthy,
    isRegressing: consecutiveUnhealthy >= REGRESSION_THRESHOLD,
  };
}
