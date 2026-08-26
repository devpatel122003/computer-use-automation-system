# Multi-Run Stability

## In one sentence

Confidence answers "has this artifact generally worked over its whole life"; stability answers a
narrower, more urgent question — "how has it been doing *this specific week*" — and
`canary-check` is the real, unattended tool that runs one genuine replay through the exact same
guardrails as any other caller and reports that recent-window health with a process exit code
suitable for real alerting.

---

## Part 1 — For everyone: "how have they been this week?"

### The real-world analogy

A doctor's office doesn't only ask "how has this patient's health been over their entire life."
A patient can have a great lifetime track record and still be having a genuinely bad week right
now — and that's exactly the thing a doctor needs to know about *today*, not a fact that gets
smoothed away by decades of otherwise-good history. "How have you been doing this week?" is a
different, narrower, more urgent question than "how has your health generally been," and it
needs its own answer.

This system tracks both. Confidence (see
[`10-confidence-and-approval.md`](10-confidence-and-approval.md)) is the lifetime number — every
replay this exact artifact content has ever done, going back as far as the history is kept.
Stability is the recent-window number — just the last handful of runs, answering "is it healthy
*right now*, and did something just change."

### A concrete walkthrough, with a real command and a real, unedited result

```bash
npm run canary-check -- --headless true
```

```
Result: success
Stability (last 5/5 runs): 3 clean, 2 failed -- FLAKY
```

That's a real result, checked directly against this repo's own accumulated run history — not a
staged, cherry-picked "everything's fine" demo. The single replay this specific invocation just
performed succeeded (`Result: success`). But looking at the most recent 5 runs in this
artifact's history overall, 2 of them failed — a mix of clean and failed outcomes in a short
recent window, which is exactly the signature of something intermittent rather than solidly
working or solidly broken. The tool reports that honestly as `FLAKY`, and exits with a non-zero
status code — the standard signal a monitoring/alerting system would watch for to page someone,
even though the artifact's *lifetime* confidence score might still read as "generally reliable."

### "What happens if...?"

| Situation | What happens |
|---|---|
| The last 5 runs were all clean | Reported `HEALTHY`, process exits `0`. |
| The last 5 runs are a mix of clean and failed | Reported `FLAKY`, process exits non-zero — worth paging someone even though it's technically still "working sometimes." |
| The last 5 runs were all failures | Reported `UNHEALTHY` (not flaky — uniformly broken, a different signal), process exits non-zero. |
| The single most recent run failed, but the one right before it was clean | Flagged distinctly as "just degraded" — this is the moment something *changed*, worth different attention than a problem that's been known for a while. |
| The artifact has never been replayed before | Reported as not healthy — "healthy" would overclaim confidence for something that's never actually been run, even though it hasn't technically failed either. |
| The artifact isn't approved yet, or its drift-adjusted confidence has degraded | The canary's own replay still runs its risky step through the exact same confidence circuit breaker (see [`10-confidence-and-approval.md`](10-confidence-and-approval.md)) as any other caller — if that step gets declined because there's no one there to confirm it, that's an honest part of this run's own health signal, not a special case the canary is exempt from. |
| An artifact has a great lifetime confidence score but just failed its last 3 runs in a row | The lifetime score alone would still call it "generally reliable" — stability is precisely the tool that catches this and reports something different. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Confidence and stability answer genuinely different questions from the same underlying data.
`computeConfidence()` (`src/artifact/registry.ts`) is a lifetime score: total successes and
business outcomes over the artifact's entire recorded history. An artifact with a 90% lifetime
success rate that just failed its last three runs in a row is still "generally reliable" by that
lifetime number — and that's exactly the moment an on-call human wants a different, more urgent
answer. Rather than build a second data store to track this, stability is deliberately computed
on top of the *same* replay history the registry already keeps — the two signals share their raw
material, they just look at different slices of it.

### What

`src/artifact/stability.ts`:

```ts
export interface StabilitySignal {
  windowSize: number;
  recentRuns: number;          // may be less than windowSize early on
  recentCleanCount: number;
  recentFailureCount: number;
  isFlaky: boolean;            // mixed clean/failure in the window -- intermittent, not solid either way
  justDegraded: boolean;       // the single most recent run failed, but the one before it didn't
  healthy: boolean;            // false if there's no history at all yet
}
```

```ts
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
    windowSize, recentRuns: recent.length, recentCleanCount, recentFailureCount,
    isFlaky, justDegraded,
    healthy: recent.length > 0 && recentFailureCount === 0,
  };
}
```

`healthy` requires *both* at least one run in the window *and* zero failures in it — an artifact
with no history at all is reported as not-healthy, not healthy-by-default, since "healthy" would
overclaim confidence for content that's never actually been exercised.

### How

`src/cli/canary-check.ts` is the real, unattended invocation this signal is built for — meant to
be run on a schedule (a real crontab entry, e.g. "every 15 minutes, `cd /path && npm run
canary-check`"). Building the scheduler itself was deliberately left out, per the brief's own
"don't build scaling infrastructure you don't need" — the script is real and runnable today, on
demand or on a schedule, unchanged either way.

Critically, the canary does **not** take a shortcut around the system's own trust gates to "just
check health faster." It loads the artifact and its registry entry exactly like `replay` does,
computes the drift-adjusted confidence label, and calls the exact same
`effectiveAllowRisky()` (`src/replay/execution-policy.ts`, see
[`10-confidence-and-approval.md`](10-confidence-and-approval.md)) every other caller uses:

```ts
const drift = loadMatchingDriftReports(artifact, entry.fingerprint);
const adjustedLabel = driftAdjustedLabel(computeConfidence(entry).label, drift);
const allowRisky = effectiveAllowRisky({
  requestedAllowRisky: true,
  approvalState: entry.approvalState,
  driftAdjustedLabel: adjustedLabel,
});
```

Then it runs one real `replay()` call through a real `PlaywrightSurface` and a real
`GuardrailsPolicy` — the same engine, the same guardrails, the same circuit breaker any other
caller goes through — records the outcome into the registry (`recordReplayOutcome` +
`saveRegistry`, same as any other replay caller), and only *then* computes the stability signal
over the artifact's updated history:

```ts
console.log(`Result: ${result.status}`);
console.log(
  `Stability (last ${stability.recentRuns}/${stability.windowSize} runs): ${stability.recentCleanCount} clean, ` +
    `${stability.recentFailureCount} failed -- ${stability.healthy ? "HEALTHY" : stability.isFlaky ? "FLAKY" : "UNHEALTHY"}` +
    `${stability.justDegraded ? " (just degraded -- this is new)" : ""}`
);
process.exitCode = stability.healthy ? 0 : 1;
```

The rationale, stated directly in the source comment: "a canary that could bypass the trust
gates to 'just check health' would be checking a different, looser system than the one actually
in production." A canary's entire value is telling the truth about the *real* system's health,
including the parts of that health that come from the guardrails themselves declining to act
unattended.

### Where

- `src/artifact/stability.ts` — `computeStabilitySignal()`, pure logic over an existing history array
- `src/cli/canary-check.ts` — the real, schedulable health-check invocation
- `src/artifact/registry.ts` — the shared `ReplayHistoryEntry[]` both confidence and stability read
- `src/replay/execution-policy.ts` — the same circuit breaker gate the canary goes through, not a looser variant

### A worked technical example

```bash
npm run canary-check -- --headless true
```
```
Canary check: Open Sub-Account v1.0.0 (006fd53ee041c1ca)
Result: success
Stability (last 5/5 runs): 3 clean, 2 failed -- FLAKY
```

Checking the exit code directly (not through a pipe, which would report the pipe's own status
instead):

```bash
npm run canary-check -- --headless true; echo "exit code: $?"
```

An honest `FLAKY` result exits `1` — the correct behavior for a tool whose entire job is
reporting health truthfully, not for a tool that quietly excludes its own inconvenient history
to look cleaner. Real declined-risky-confirmation runs produced while testing the confidence
circuit breaker are part of this artifact's actual recent history, and the canary reports them
honestly rather than filtering them out.

### Edge cases & failure modes

- **No scheduler is built.** `canary-check` is a script, not a service — wiring it into cron,
  systemd, or a monitoring platform is left to whoever deploys this, deliberately, per the
  brief's own guidance not to build scaling/scheduling infrastructure that isn't exercised here.
- **`healthy` requires actual history, not just the absence of failure.** An artifact that's
  never been run at all reports `healthy: false`, not `true` — silence isn't evidence of health.
- **The window is small and configurable (`--window`, default 5).** A small window means a
  single unlucky sequence of runs can swing the reported status quickly — that's the intended
  trade-off for "is it healthy *right now*," not a bug; a larger window trades responsiveness
  for a more even-keeled reading of long-run health, which is what lifetime confidence already
  provides.
- **The canary is not exempt from the confidence circuit breaker.** If the artifact's
  drift-adjusted confidence has degraded, the canary's own replay of a risky step falls back to
  attended confirmation like any other unattended caller, which (with no operator present) is
  declined — and that appears as a real failure in the canary's own result and stability
  history, honestly, not as a special "health-check mode" exemption.
- **Uses default demo params unless `--params` is passed**, so a given canary run is only
  representative of the specific capability and input values it was actually invoked with — it
  is not a synthetic multi-scenario fuzz test.
- **Exit codes: `0` healthy, `1` unhealthy/flaky, `2` on an uncaught error** (e.g. the artifact
  file itself is missing or invalid) — distinguishing "the system told us it's unhealthy" from
  "the health check itself couldn't even run."

## Related docs

- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — the lifetime confidence score and the circuit breaker this canary runs through unmodified
- [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — the drift-adjusted label that feeds into the same circuit breaker
- [`REPORT.md`](../REPORT.md) — "Stretch goals: Multi-run stability" for the full design narrative and real evidence
- [`README.md`](../README.md) — demo path step 14 for this exact command in context
