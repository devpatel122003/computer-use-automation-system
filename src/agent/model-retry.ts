import type { EvidenceLogger } from "../evidence/logger.js";

/**
 * Shared resilience for any real Gemini call in this codebase -- originally only the
 * discovery loop had this. Free-tier quotas are tight (e.g. 5 req/min) and transient 5xx
 * ("Internal error encountered" / "high demand") responses are a real, repeatedly observed
 * failure mode, not a hypothetical -- hit live while producing evidence for both the
 * conversational front end (src/frontend/planner.ts) and assisted recovery
 * (src/replay/assisted-recovery.ts), which previously had no retry at all and would fail
 * (or, for assisted recovery, correctly-but-needlessly degrade to "didn't recover") on a
 * single transient blip that a short backoff would have ridden out.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withModelRetry<T>(fn: () => Promise<T>, logger?: EvidenceLogger, maxAttempts = 6): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = status === 429 || message.includes("RESOURCE_EXHAUSTED");
      const isServerError = status !== undefined && status >= 500;
      if ((!isRateLimit && !isServerError) || attempt === maxAttempts) throw err;

      let delayMs: number;
      if (isRateLimit) {
        const match = message.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
        delayMs = (match ? Number(match[1]) : 15) * 1000 + 1000;
      } else {
        delayMs = 5000 * attempt; // simple linear backoff for transient server errors
      }
      const summary = `Gemini ${isRateLimit ? "rate-limited" : "returned a server error"} (attempt ${attempt}/${maxAttempts}); waiting ${delayMs}ms before retry.`;
      if (logger) logger.log({ step: 0, phase: "error", summary });
      else console.error(summary);
      await sleep(delayMs);
    }
  }
  throw new Error("unreachable");
}
