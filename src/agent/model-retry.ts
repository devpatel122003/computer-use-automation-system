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

interface ErrorClassification {
  isRateLimit: boolean;
  isServerError: boolean;
  /** A per-minute rate limit clears itself in seconds; a per-day quota is exhausted until
   *  tomorrow, no matter how long this process backs off. Gemini's own error payload names
   *  the specific quota bucket in `quotaId`/`violations`, and the per-day bucket's name
   *  always contains "PerDay" -- a per-minute one never does. This is the one signal that
   *  distinguishes "wait a bit" from "this model cannot answer again today." */
  isDailyQuotaExhausted: boolean;
  message: string;
}

function classify(err: unknown): ErrorClassification {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  const isRateLimit = status === 429 || message.includes("RESOURCE_EXHAUSTED");
  const isServerError = status !== undefined && status >= 500;
  const isDailyQuotaExhausted = isRateLimit && /PerDay/i.test(message);
  return { isRateLimit, isServerError, isDailyQuotaExhausted, message };
}

function backoffDelayMs(isRateLimit: boolean, message: string, attempt: number): number {
  if (isRateLimit) {
    const match = message.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
    return (match ? Number(match[1]) : 15) * 1000 + 1000;
  }
  return 5000 * attempt; // simple linear backoff for transient server errors
}

export async function withModelRetry<T>(fn: () => Promise<T>, logger?: EvidenceLogger, maxAttempts = 6): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const { isRateLimit, isServerError, message } = classify(err);
      if ((!isRateLimit && !isServerError) || attempt === maxAttempts) throw err;

      const delayMs = backoffDelayMs(isRateLimit, message, attempt);
      const summary = `Gemini ${isRateLimit ? "rate-limited" : "returned a server error"} (attempt ${attempt}/${maxAttempts}); waiting ${delayMs}ms before retry.`;
      if (logger) logger.log({ step: 0, phase: "error", summary });
      else console.error(summary);
      await sleep(delayMs);
    }
  }
  throw new Error("unreachable");
}

/**
 * Reads GEMINI_MODEL (primary) and the optional GEMINI_FALLBACK_MODELS (comma-separated,
 * tried in order) into the ordered list withModelFallback consumes. This is the demo-day
 * answer to README's own disclosed risk: "once a model's whole daily quota is gone, no
 * amount of retrying helps" -- previously the only fix was to notice the failure, edit
 * .env, and restart. Now the process itself can fall through to a second model without a
 * restart, mid-run.
 */
export function resolveModelList(): string[] {
  const primary = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== primary);
  return [primary, ...fallbacks];
}

/**
 * Same backoff-and-retry as withModelRetry, plus one more layer: a daily-quota exhaustion
 * (permanent until tomorrow) skips straight to the next model in `models` instead of
 * burning `maxAttemptsPerModel` retries against a model that cannot possibly answer again
 * today. A per-minute rate limit or a transient 5xx still retries the *current* model first,
 * exactly like withModelRetry alone -- falling back on those would abandon a model that most
 * likely would have worked after a short wait, which is not the problem this solves.
 *
 * Deliberately re-starts from `models[0]` on every call rather than remembering which model
 * last worked across turns: a discovery run only calls this a handful of times, so the
 * worst case is one extra fast-failing call to an exhausted primary per turn, not a
 * meaningful delay -- persisting cross-call state for that saving would be exactly the kind
 * of infrastructure the brief says not to build for a problem this small.
 */
export async function withModelFallback<T>(
  models: string[],
  fn: (model: string) => Promise<T>,
  logger?: EvidenceLogger,
  maxAttemptsPerModel = 6
): Promise<T> {
  if (models.length === 0) throw new Error("withModelFallback requires at least one model.");

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    const hasNextModel = modelIndex < models.length - 1;

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        return await fn(model);
      } catch (err) {
        const { isRateLimit, isServerError, isDailyQuotaExhausted, message } = classify(err);

        if (isDailyQuotaExhausted) {
          if (!hasNextModel) {
            throw new Error(`All configured Gemini models (${models.join(", ")}) have exhausted their daily quota. ${message}`);
          }
          const summary = `Gemini model "${model}" has exhausted its daily quota; falling back to "${models[modelIndex + 1]}".`;
          if (logger) logger.log({ step: 0, phase: "error", summary });
          else console.error(summary);
          break; // stop retrying this model, move to the next one in the outer loop
        }

        if ((!isRateLimit && !isServerError) || attempt === maxAttemptsPerModel) throw err;

        const delayMs = backoffDelayMs(isRateLimit, message, attempt);
        const summary = `Gemini ${isRateLimit ? "rate-limited" : "returned a server error"} on model "${model}" (attempt ${attempt}/${maxAttemptsPerModel}); waiting ${delayMs}ms before retry.`;
        if (logger) logger.log({ step: 0, phase: "error", summary });
        else console.error(summary);
        await sleep(delayMs);
      }
    }
  }
  throw new Error("unreachable");
}
