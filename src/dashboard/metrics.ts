import type { LogEvent } from "../evidence/logger.js";

/**
 * Discovery-vs-replay cost/time comparison, computed from the same log timestamps every
 * run already writes -- no synthetic numbers. This is the system's own value proposition
 * (record once with a model, replay deterministically for free forever) turned into a
 * number instead of a sentence. See src/dashboard/server.ts for how it's assembled per
 * capability, and REPORT.md for why replay's `llmCalls` is definitionally always 0.
 */

export interface RunMetrics {
  runId: string;
  durationMs: number;
  /** Count of "decide" phase log entries -- one per model call. Always 0 for a replay run;
   *  replay never calls the model (see src/replay/replay-engine.ts). */
  llmCalls: number;
}

/** Duration is first-event-ts to last-event-ts for one run's log -- every run's log is
 *  append-only and already chronological, so no sorting is needed. */
export function computeRunMetrics(runId: string, events: LogEvent[]): RunMetrics | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const durationMs = Math.max(0, new Date(last.ts).getTime() - new Date(first.ts).getTime());
  const llmCalls = events.filter((e) => e.phase === "decide").length;
  return { runId, durationMs, llmCalls };
}

export interface AggregateMetrics {
  runCount: number;
  avgDurationMs: number;
  avgLlmCalls: number;
}

export function aggregateRunMetrics(runs: RunMetrics[]): AggregateMetrics | null {
  if (runs.length === 0) return null;
  return {
    runCount: runs.length,
    avgDurationMs: runs.reduce((sum, r) => sum + r.durationMs, 0) / runs.length,
    avgLlmCalls: runs.reduce((sum, r) => sum + r.llmCalls, 0) / runs.length,
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** How many times faster the replay average is than the discovery average, as a display
 *  string -- null if there's not enough data on either side to say anything honest. */
export function formatSpeedup(discoveryAvgMs: number, replayAvgMs: number): string | null {
  if (replayAvgMs <= 0 || discoveryAvgMs <= 0) return null;
  const factor = discoveryAvgMs / replayAvgMs;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return `${factor.toFixed(1)}x`;
}
