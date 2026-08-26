# Gemini Quota and Resilience

## In one sentence

Every real call to Gemini in this codebase goes through shared retry logic that treats a
"busy right now" failure (a per-minute rate limit, or a transient server hiccup) completely
differently from an "out for the day" failure (the model's whole daily quota is used up) —
retrying and waiting helps the first, and only switching to a different model in
`GEMINI_FALLBACK_MODELS` helps the second.

---

## Part 1 — For everyone: two different kinds of "no," and two different responses

### The analogy

Imagine you need to ask a coworker a quick question, and you call their desk phone.

- Sometimes they're just **on another call right now**. If you wait thirty seconds and call
  back, you'll probably get through — the busy-ness is temporary and will clear on its own.
  Calling back immediately, and again if needed, is exactly the right move.
- Sometimes, though, they've **already gone home for the day**. No amount of waiting and
  redialing gets you through — they're not coming back to the phone until tomorrow. The
  right move here isn't "wait longer," it's "call someone else on the team who's still in
  the office."

A system that can't tell these two situations apart wastes a lot of time. If it treats
"gone home for the day" the same as "on another call," it'll keep redialing a phone that
will never be answered again today — uselessly burning time that could have gone to
calling the next person on the list right away.

### What this looks like in the actual project

This project calls Google's Gemini AI model for several things: the discovery agent
deciding what to click next, the conversational front end turning a plain-English request
into a capability call, and the "assisted recovery" fallback that asks the model to look at
a screenshot when normal automation gets stuck. Free-tier Gemini API keys have small daily
quotas, and it's genuinely easy for a single ~10-step discovery run to use up a whole day's
allowance on one model.

When Gemini says "no" to a request, this project looks at *why* it said no:

- **"I'm busy right now"** — a per-minute rate limit, or the server having a rough moment.
  The code waits a bit (following Gemini's own suggested wait time when it provides one)
  and tries the *same* model again. This is `withModelRetry`, and it existed first.
- **"I'm done for today"** — the *daily* quota for this specific model is fully used up. No
  amount of waiting fixes this until the quota resets tomorrow. The newer code,
  `withModelFallback`, recognizes this specific case and, instead of wasting time waiting
  and retrying a model that flatly cannot answer again today, immediately moves on to the
  next model listed in `GEMINI_FALLBACK_MODELS` (for example
  `gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.0-flash`) and tries that one instead.

If every model in the list has also run out for the day, the system says so plainly —
`"All configured Gemini models (...) have exhausted their daily quota"` — rather than
hanging or giving a confusing timeout.

### A concrete walkthrough

Say `GEMINI_MODEL=gemini-3.7-flash` and `GEMINI_FALLBACK_MODELS=gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.0-flash`,
and you run `npm run run-agent` for the fourth time today, having already burned through
`gemini-3.7-flash`'s daily quota on earlier runs.

1. Discovery asks `gemini-3.7-flash` what to do next.
2. Gemini replies with an error whose quota-bucket name contains `"PerDay"` — this specific
   model's daily allotment is gone.
3. The system logs `Gemini model "gemini-3.7-flash" has exhausted its daily quota; falling
   back to "gemini-3.5-flash-lite".` and immediately asks `gemini-3.5-flash-lite` the exact
   same question instead — no waiting, no wasted retry against a model that can't answer.
4. `gemini-3.5-flash-lite` answers normally, and the run continues as if nothing happened.

This isn't hypothetical — the README notes that the evidence checked into this repo "was
itself produced on gemini-3.5-flash-lite after several other models hit their daily cap
during testing," i.e. this exact fallback path is what let development keep moving on a
real day when the primary model ran dry.

### "What happens if...?"

| Situation | What happens |
|---|---|
| Gemini returns a 429 with no `"PerDay"` in the message (a per-minute rate limit) | The same model is retried after waiting the delay Gemini suggested (or 15s + 1s buffer if none given) — no fallback, because waiting genuinely fixes this. |
| Gemini returns a transient 5xx server error | Retried on the same model with a simple linear backoff (5s × attempt number) — a different problem from quota, same "just wait and retry" answer. |
| Gemini returns a 429 whose quota id contains `"PerDay"` | The current model is abandoned immediately (no retries burned on it) and the next model in `GEMINI_FALLBACK_MODELS` is tried right away. |
| Every model in the list has exhausted its daily quota | A clear error is thrown naming every model that was tried, instead of a generic timeout. |
| `GEMINI_FALLBACK_MODELS` isn't set at all | Behavior is unchanged from before this feature existed — only `GEMINI_MODEL` is tried, with the same retry-on-transient-failure behavior as always. |
| You're mid-demo and every configured model is exhausted | Edit `GEMINI_FALLBACK_MODELS` (or `GEMINI_MODEL`) in `.env` and re-run the command — every entry point reads the model list fresh at process start, so nothing else needs to change. |
| A call keeps failing for six straight attempts on one model, none of them quota- or server-related (e.g. a genuine bad-request error) | Retry logic doesn't apply at all — a non-retryable error is thrown immediately on the first attempt, since waiting and trying again would never help it. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Gemini's free-tier flash-model quotas are small (single digits to low tens of
requests/day), and every real call in this codebase — discovery, the conversational
planner, assisted/vision recovery — can trip either a per-minute limit or a full daily
exhaustion. Treating both the same way (either "always retry the same model" or "always
give up") is wrong in both directions: always-retry wastes real wall-clock time hammering a
model that is provably not going to answer again today; always-give-up throws away runs
that a two-second wait would have saved. The fix is to make the retry logic itself
distinguish the two cases using the one signal Gemini's own error payload provides.

### What

Both live in `src/agent/model-retry.ts`:

- **`withModelRetry<T>(fn, logger?, maxAttempts = 6)`** — the original mechanism. Retries a
  single model call up to `maxAttempts` times for rate limits or server errors; anything
  else (or the final attempt) is thrown immediately.
- **`resolveModelList(): string[]`** — reads `GEMINI_MODEL` (default `"gemini-3.7-flash"`)
  as the first entry, then appends `GEMINI_FALLBACK_MODELS` (comma-separated), filtering out
  blanks and any duplicate of the primary.
- **`withModelFallback<T>(models, fn, logger?, maxAttemptsPerModel = 6)`** — the newer
  mechanism, layered on top of the same retry idea, that also walks forward through
  `models` on daily-quota exhaustion.

### How

The classification that makes this possible:

```ts
function classify(err: unknown): ErrorClassification {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  const isRateLimit = status === 429 || message.includes("RESOURCE_EXHAUSTED");
  const isServerError = status !== undefined && status >= 500;
  const isDailyQuotaExhausted = isRateLimit && /PerDay/i.test(message);
  return { isRateLimit, isServerError, isDailyQuotaExhausted, message };
}
```

Gemini's own error payload names the specific quota bucket that was violated
(`quotaId`/`violations`), and a per-day bucket's name always contains `"PerDay"` while a
per-minute one never does — this is the one signal that distinguishes "wait a bit" from
"this model cannot answer again today," and the code leans on Gemini's own wording rather
than trying to infer it indirectly.

`withModelFallback`'s core loop:

```ts
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
        // log, then break out of the attempt loop to advance to the next model
        break;
      }
      if ((!isRateLimit && !isServerError) || attempt === maxAttemptsPerModel) throw err;
      await sleep(backoffDelayMs(isRateLimit, message, attempt));
    }
  }
}
```

Two trade-offs are worth calling out explicitly, both deliberate:

1. **Daily-quota exhaustion skips remaining retries on that model entirely** (`break`, not
   another `attempt`) — retrying a model against a failure mode that provably cannot
   resolve until tomorrow would only burn time and API calls for no chance of success. A
   per-minute rate limit or transient 5xx, by contrast, still gets the *full*
   `maxAttemptsPerModel` retries on the *current* model before anything falls back — because
   those genuinely might resolve on the very next try.
2. **The model list restarts from `models[0]` on every call**, rather than remembering which
   model last succeeded across turns. A discovery run only makes a handful of these calls
   per run, so the worst case of restarting from the top is one extra fast-failing call to
   an already-exhausted primary per turn — not a meaningful delay. Persisting "which model
   worked last time" across calls would be exactly the kind of extra state/infrastructure
   the brief warns against building for a saving this small.

`backoffDelayMs` reads Gemini's own suggested `"retryDelay":"Ns"` out of the error message
when present (`+1000ms` buffer), falling back to 15s if Gemini didn't specify one; for
non-rate-limit server errors it uses simple linear backoff, `5000 * attempt`.

### Worked technical example

```ts
import { withModelFallback, resolveModelList } from "./src/agent/model-retry.js";

const models = resolveModelList();
// e.g. ["gemini-3.7-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]

const result = await withModelFallback(models, async (model) => {
  return client.models.generateContent({ model, contents: [...] });
});
```

Realistic console output when the primary model's daily quota is gone:

```
Gemini model "gemini-3.7-flash" has exhausted its daily quota; falling back to "gemini-3.5-flash-lite".
```

...and, if every configured model were exhausted:

```
Error: All configured Gemini models (gemini-3.7-flash, gemini-3.5-flash-lite, gemini-2.5-flash, gemini-2.0-flash) have exhausted their daily quota. <original Gemini error message>
```

### Edge cases & failure modes

- **`models` is an empty array** — `withModelFallback` throws immediately
  (`"withModelFallback requires at least one model."`) rather than silently doing nothing.
- **A non-retryable error on a non-final attempt** (e.g. a malformed request, not a rate
  limit or server error) — thrown immediately without waiting or advancing models; retrying
  or falling back would never help a genuinely bad request.
- **The very last attempt on the very last model is still a retryable error** —
  thrown as-is once `attempt === maxAttemptsPerModel` and there's no next model, rather than
  looping forever.
- **A caller supplies a `logger`** (an `EvidenceLogger`) — every retry/fallback decision is
  written to evidence as an `"error"`-phase log line instead of only going to `console.error`,
  so a real run's evidence trail shows exactly which model answered and why any fallback
  happened.
- **`GEMINI_FALLBACK_MODELS` lists the same value as `GEMINI_MODEL`** — filtered out by
  `resolveModelList()`, so the list never retries the identical model twice under two names.

## Related docs

- [`04-discovery-agent.md`](04-discovery-agent.md) — the discovery loop that makes the majority of these calls
- [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md) — another real caller of this same retry/fallback logic
- [`02-glossary.md`](02-glossary.md) — plain-language definitions of the terms used here
- [`../README.md`](../README.md) — "Setup" and "Gemini quota fallback" for the same story with real CLI output
- [`../REPORT.md`](../REPORT.md) — the original design write-up this expands on
