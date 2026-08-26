# Deterministic Replay

## In one sentence

Once a task has been learned once (during discovery), every future run of it is executed by a
small, boring, model-free program that follows the recorded recipe exactly, checks its work
after every step, knows about a handful of normal things that can go wrong, and — critically —
always tells you which of three fundamentally different things happened: it worked, it got a
normal business answer, or it genuinely doesn't know what just happened.

---

## Part 1 — For everyone: what happens when you press "go" on a recorded task

### The real-world analogy

Imagine a laminated recipe card, written by a chef the first time they made a dish, with every
step spelled out precisely: "crack two eggs into the bowl on the left," not "add eggs." Now
someone with zero cooking experience follows that card, over and over, for the next thousand
customers. They don't need to *understand* cooking. They just need to be able to tell three
things apart when something doesn't go exactly as printed:

1. The dish came out exactly as expected — great, serve it.
2. A customer asked for a dish that isn't on the menu, or doesn't exist as an order — that's a
   normal, useful thing to know and say back ("we don't have that"), not a kitchen disaster.
3. Something happened that the card never mentions — the oven caught fire, the ingredient bag
   was empty. *That* is worth stopping and calling the head chef over, because guessing is
   dangerous.

The replay engine in this project is that recipe-follower. The "recipe card" is the **capability
artifact** that discovery produced (see
[`05-artifact-schema.md`](05-artifact-schema.md)); the replay engine is
`src/replay/replay-engine.ts`.

### A concrete walkthrough, using the real demo artifact

This project's demo artifact, `open-sub-account.artifact.json`, encodes: sign on, look up a
member, open a new sub-account, and land on a confirmation page. Every example below is a real,
documented command from this repo's own [`README.md`](../README.md) — not invented data.

**Case 1 — a member who simply doesn't exist: member `40404`.**

You type in member ID `40404` and press enter (or, technically, run):

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"40404","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

Here's exactly what happens on screen, in order: the system signs on, types "40404" into the
member search box, clicks "Look Up Member" — and the page comes back saying "No member found
with ID 40404." The system recognizes those exact words as something it was told, in advance,
to expect. It doesn't panic, retry forever, or report a crash. It reports back:

```json
{
  "status": "business_outcome",
  "outcome": "member_not_found",
  "description": "No member exists with the given memberId. A legitimate result, not a crash.",
  "stepId": "step-6"
}
```

That's a complete, correct, useful answer — the equivalent of a bank teller saying "I don't see
an account under that number," not a system error.

**Case 2 — a member the operator isn't allowed to see: member `99999`.**

Same command, `memberId` swapped to `99999`. The page comes back "Access denied" instead of the
member's account page. Again, this is a known, expected shape of answer — the system reports:

```json
{
  "status": "business_outcome",
  "outcome": "permission_denied",
  "description": "The signed-on operator is not permitted to view this member's accounts.",
  "stepId": "step-6"
}
```

Nothing about this looks like a crash to whatever asked for the lookup — because it isn't one.

**Case 3 — a session that times out mid-task: member `90909`.**

This one is different: partway through (right after searching for the member), the internal
software decides the operator's session has expired and bounces back to the sign-on screen with
the words "session has expired." The replay engine recognizes *that* text too, but this time it's
tagged as **recoverable**, not a business answer. So, entirely on its own, with no human
involved: it re-types the operator ID, re-types the password, re-clicks "Sign On," re-types the
member ID into the search box (because the redirect wiped that out too), and then retries the
one step that had failed. This is a real, logged sequence from this repo's own evidence:

```
6  checkpoint  Checkpoint for step-6: failed
0  outcome     Detected known outcome "session_timeout" (recoverable)
0  act         Recovery re-ran step-2 (type): ok
0  act         Recovery re-ran step-3 (type): ok
0  act         Recovery re-ran step-4 (click): ok
0  act         Recovery re-ran step-5 (type): ok
6  act         Performed click (step-6): ok
6  checkpoint  Checkpoint for step-6: passed
```

...and the run finishes with a normal `success`, confirmation number and all. From the outside,
it just looks like the task worked — a little slower than usual, because the system quietly
fixed its own hiccup.

**Case 4 — something genuinely unexpected: an account type of `MoneyMarket`.**

The mock bank's dropdown only actually offers Savings, Checking, and CD — `MoneyMarket` isn't a
real option. Nothing in the artifact's list of "things I know how to recognize" explains this,
so after retrying and waiting the usual amount of time, the step just... doesn't find the option
it needs. The system doesn't guess, doesn't quietly pick a different option, doesn't pretend it
worked. It reports, honestly, that it doesn't know what happened, with a screenshot and enough
detail for a person to go look:

```json
{
  "status": "failure",
  "stepId": "step-8",
  "expected": "select_option to succeed",
  "observed": "locator.selectOption: Timeout 5000ms exceeded. ... did not find some options",
  "evidenceRef": "evidence/runs/replay-2026-08-14T20-49-43-683Z/screenshots/001-failure-step-8.png"
}
```

This is the case the whole system is built to be honest about — and the case a lazier design
would be tempted to lump in with "no such member" (both look, superficially, like "the thing I
wanted didn't happen"). Conflating them would either cry "system error!" over a routine business
answer, or silently swallow a genuine bug as if it were a normal "no."

### "What happens if...?"

| Situation | What happens |
|---|---|
| Member `40404` (doesn't exist) | `business_outcome: member_not_found` — a normal answer, reported cleanly. |
| Member `99999` (permission denied) | `business_outcome: permission_denied` — same idea, different normal answer. |
| Member `90909` (session times out once, mid-task) | Automatically recognized, automatically fixed (re-signs on, retries), then finishes normally — no human needed. |
| Member `55555` (a page that's just slow that day) | Absorbed by the normal wait/retry policy — not treated as an error at all. |
| `accountType: "MoneyMarket"` (not a real option on this page) | Genuine `failure`, reported honestly with a screenshot and exact error text — nobody pretends it worked. |
| A step's action fails once, then the *exact same* known outcome recurs immediately after one recovery attempt | The system does **not** try to recover a second time — it hard-fails, because a problem that survives one fix attempt is a systemic issue, not a flaky blip. |
| Someone with terminal access has enabled interactive escalation (`--interactive-escalation true`) and a genuine failure happens | A human is offered one chance to fix the live page by hand and say "resume" — the run does not simply end. |
| Nobody is watching (this replay is running as an unattended service, e.g. the capability API) | No prompt is ever shown; a genuine failure fails immediately, since there's no one to ask. |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief calls out, explicitly, that conflating "the answer was no" with "something broke" is
the single most common design mistake in this category of system. A replay engine that reports
`error` for both "member 40404 doesn't exist" and "the page threw an unhandled exception" forces
every downstream caller (a human, or an AI agent invoking this as a capability) to re-derive,
from prose, which of those two totally different situations it's actually in. This system instead
makes that distinction a first-class part of the return type, so no caller ever has to guess.

The corollary: transient runtime noise (a slow page, a session that expired for reasons that have
nothing to do with the task) shouldn't need a human either. Only genuine, unanticipated deviation
should ever reach a human — and even then, exactly once per step, so a systemically broken step
can't turn into an infinite prompt loop.

### What — the three-way result contract

`src/replay/types.ts` defines `ReplayResult` as a discriminated union on `status`:

```ts
export interface ReplaySuccessResult {
  status: "success";
  runId: string;
  outputs: Record<string, string>;
}

export interface ReplayBusinessOutcomeResult {
  status: "business_outcome";
  runId: string;
  outcome: string;
  description: string;
  stepId?: string;
  evidenceRef?: string;
}

export interface ReplayFailureResult {
  status: "failure";
  runId: string;
  stepId: string;
  expected: string;
  observed: string;
  evidenceRef: string;
}
```

- **`success`** — every step's checkpoint held, the artifact's `successCheckpoint` held, and any
  `extract` steps' values are returned in `outputs`.
- **`business_outcome`** — a step's mechanical action executed fine, but the checkpoint didn't
  hold — *and* the live page matches one of the artifact's own `knownOutcomes` detectors,
  category `business_outcome`. This is a correct, complete answer, not a crash: the replay CLI
  exits `0` for it, exactly like `success`.
- **`failure`** — nothing in `knownOutcomes` explains the deviation. Carries the step id, what
  was expected, what was actually observed, and a screenshot path (`evidenceRef`) specifically so
  a human can debug without re-running anything live.

### How — the moving parts, in call order

**1. Zero model calls, ever.** `replay()` (`src/replay/replay-engine.ts`) builds every `Action`
straight from `ArtifactStep` data (`buildAction`) — there is no code path in this file that calls
an LLM. (The one narrow, opt-in exception, `assistedRecovery`, is a separate, explicitly-enabled
feature — see below — and is never on by default.)

**2. The same locator fallback chain discovery recorded.** Each step's `locator` is an ordered
array of `LocatorCandidate`s (`role` → `text` → `css_structural`, roughly in that
confidence order — see [`03-surface-abstraction.md`](03-surface-abstraction.md)). `Surface.perform()`
tries them in order and records which one actually matched, which is what
[`12-ui-drift-detection.md`](12-ui-drift-detection.md) later mines for signs the underlying page
has changed shape since recording.

**3. Wait/retry policy.** Every step carries a `waitPolicy: { timeoutMs, retries }`. A failed
action is retried up to `retries` times before anything else is even considered a real problem —
this is what absorbs ordinary, non-business flakiness like a page that's slow to render (the
mock app's simulated 3-second slow-load for member `55555`) with no special-casing anywhere in
this file.

**4. Known-outcome detection (`detectKnownOutcome` → `evaluateCheckpoint`).** When a step's action
fails, or its `checkpoint` doesn't hold, the engine walks `artifact.knownOutcomes` in order and
runs each one's own `detector` (itself just a `Checkpoint` — `url` / `text_match` /
`element_visible`) against the live page. The first match wins. In the demo artifact
(`src/cli/capabilities/open-sub-account.ts`) these are:

| `name` | `category` | detector | recovery |
|---|---|---|---|
| `member_not_found` | `business_outcome` | text contains "No member found with ID" | — |
| `permission_denied` | `business_outcome` | text contains "Access denied" | — |
| `validation_error` | `business_outcome` | element-visible on the deposit-amount error banner | — |
| `session_timeout` | `recoverable` | text contains "session has expired" | `reauthenticate_and_retry_step`, replaying `step-2, step-3, step-4, step-5` (re-login *and* re-entering the search field the redirect wiped out) |

`handleOutcome()` branches on `category`:
- `business_outcome` → takes a screenshot for the record, returns the `business_outcome` result.
- `recoverable` with `recovery: "reauthenticate_and_retry_step"` → runs `runRecoverySteps()`
  against `recoveryStepIds`, then signals "retry the step that originally failed."
- `recoverable` with `recovery: "retry_step"` → no prior steps to replay, just retry the same
  action again (used where the fix is simply "try once more," with nothing upstream to redo).
- `hard_failure`, or a `recoverable` outcome missing a recovery procedure the engine actually
  knows how to execute → falls through to a normal `failure`, rather than being silently treated
  as handled.

**5. The one-recovery-attempt cap, and why.** `MAX_RECOVERY_ATTEMPTS_PER_STEP = 1`. If the exact
same known outcome recurs immediately after one recovery pass (e.g. the session times out again
right after re-authenticating), that's evidence of a systemic problem — a second automatic
attempt wouldn't fix it, and looping would just hide a real issue behind a longer runtime instead
of surfacing it. One clean, real, checked-in example of this whole recovery path executing end to
end is `evidence/runs/replay-2026-08-14T20-32-36-818Z/log.jsonl` for member `90909` (excerpted in
Part 1 above): checkpoint fails at `step-6` → `session_timeout` detected → `step-2`–`step-5`
re-run as recovery → `step-6` retried → checkpoint passes → run finishes `success`.

**6. The guardrail re-check on every action, everywhere — `authorizeAndConfirm`.** This is the one
and only place in this file that calls `Surface.perform()` after asking
`GuardrailsPolicy.authorize()` first. It's used for the step's original attempt, for *each*
recovery step, and for the post-recovery retry of the step that failed — not just the first
attempt. This closes a real, previously-shipped gap: an earlier version let recovery and retries
call the surface directly, so a risky `POST` (e.g. re-submitting "open this sub-account") could
effectively re-fire during "recovery" with zero re-authorization and zero re-confirmation, even in
a run that required interactive confirmation for its first attempt. Recovery is not a side door
around guardrails; it goes through the identical gate every other action does (see
[`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) for what that gate itself checks).

**7. The landed-URL re-check after navigation.** After a `navigate` or `click` actually executes
(and also after a successful assisted-recovery action), `authorizeLandedUrl()` re-checks the
*actual* current URL against the allowlist — not just the URL `predictNavigation()` guessed
before the click happened. This matters because a redirect chain, or a validation error
re-rendered in place as the direct response to a `POST` instead of an actual redirect, can land
the browser somewhere the pre-flight check never saw. The identical re-check also runs after a
human resolves an escalation (`resumeAfterEscalation`) — a human's manual navigation is a real
navigation too, not exempt from where it's allowed to land.

**8. Escalation on a genuine hard failure — `tryEscalate` / `resumeAfterEscalation`.** When a step
is about to hard-fail (nothing in `knownOutcomes` explains it, and assisted recovery either wasn't
configured or didn't help), `tryEscalate()` is the single call site that decides what happens
next:

```ts
const MAX_ESCALATION_ATTEMPTS_PER_STEP = 1;

async function tryEscalate(ctx, step, stepNum, escalationAttempt, reason, fallback): Promise<StepOutcome> {
  if (!ctx.onEscalate || escalationAttempt >= MAX_ESCALATION_ATTEMPTS_PER_STEP) {
    return { outcome: "failure", result: fallback };
  }
  const decision = await ctx.onEscalate({ step, stepNum, reason });
  if (decision !== "resume") return { outcome: "failure", result: fallback };
  return resumeAfterEscalation(ctx, step, stepNum, escalationAttempt + 1);
}
```

If no `onEscalate` callback was supplied (the default everywhere — the capability API, canary
checks, plain `npm run replay` without `--interactive-escalation true`), or this step already
used its one escalation attempt, it declines straight to the given failure — no prompt, no hang,
no waiting for a human who isn't there. Only when a human is actually available and explicitly
opted in does `onEscalate` get called; if they say "resume," `resumeAfterEscalation()` first
re-checks the step's own checkpoint directly against the live page (skipping a redundant re-click
if the human already did the equivalent work by hand, or the action had already fired and only
the checkpoint hadn't settled yet), then falls through to a real retry — via a recursive call
into `executeStep` — only if the checkpoint still doesn't hold. This is capped at
`MAX_ESCALATION_ATTEMPTS_PER_STEP = 1` for the same reason recovery is: a failure that recurs
immediately after a human already tried once is a step that needs real debugging, not a second
prompt. Real, checked-in evidence for this exact path (not just unit tests):
`evidence/runs/replay-2026-08-26T00-40-07-082Z`, where member `77777` triggers an unmodeled
confirmation interstitial, a human (scripted, and disclosed as such in
`src/cli/escalation-resume-replay-demo.ts`) dismisses it, and the run completes with a real
confirmation number.

**9. Recovery and escalation share one execution path.** Both a mechanical action failure and a
checkpoint failure recover via the exact same recursive call back into `executeStep()`, so a
post-recovery or post-escalation retry always gets full re-verification — re-authorized,
checkpoint re-checked, output re-captured — rather than a shortcut that skips any of that. An
earlier version had two separate, less-consistent code paths for these two triggers; this file's
current shape deliberately has one.

### Where

- `src/replay/replay-engine.ts` — everything above: `replay()`, `executeStep()`,
  `authorizeAndConfirm()`, `detectKnownOutcome()`, `handleOutcome()`, `runRecoverySteps()`,
  `tryEscalate()`, `resumeAfterEscalation()`.
- `src/replay/checkpoint.ts` — `evaluateCheckpoint()`, the shared logic for all three
  `Checkpoint` kinds (`url`, `text_match`, `element_visible`), used both for a step's own
  `checkpoint` and for every `knownOutcome`'s `detector`.
- `src/replay/types.ts` — the `ReplayResult` union itself.
- `src/artifact/schema.ts` — `KnownOutcomeSchema`, `ArtifactStepSchema`, `CheckpointSchema`: the
  typed shape everything above operates on.
- `src/cli/capabilities/open-sub-account.ts` — the real, human-authored `knownOutcomes` for the
  demo artifact (see the table above).
- `src/cli/replay.ts` — wires `--allow-risky`, `--assisted-recovery`, and
  `--interactive-escalation` into `ReplayOptions`.
- `apps/mock-bank/src/data.ts` — the seeded member IDs (`40404`/unseeded → not found, `99999` →
  permission-restricted, `55555` → simulated slow load, `90909` → the timeout scenario, `77777` →
  the unmodeled interstitial) that make every example above reproducible on demand.

### A worked technical example

Requesting a genuinely unsupported `accountType`:

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"MoneyMarket","initialDeposit":"100"}' \
  --allow-risky true
```

```json
{
  "status": "failure",
  "stepId": "step-8",
  "expected": "select_option to succeed",
  "observed": "locator.selectOption: Timeout 5000ms exceeded. ... did not find some options",
  "evidenceRef": "evidence/runs/replay-2026-08-14T20-49-43-683Z/screenshots/001-failure-step-8.png"
}
```

Nothing in `knownOutcomes` matches whatever text is on screen after this failure, so
`detectKnownOutcome()` returns nothing, there's no known recovery to attempt, and (with no
`--interactive-escalation` flag passed) `tryEscalate()` has no callback to call — the engine
reports the failure immediately, honestly, with the exact Playwright error and a screenshot. This
same run is also what dropped this artifact's recorded confidence score from `high` to `medium` in
`evidence/artifacts/registry.json` — see
[`10-confidence-and-approval.md`](10-confidence-and-approval.md) for how a `failure` (and only a
`failure`) counts against an artifact's trust score.

### Edge cases & failure modes

- **A malformed `checkpoint.expr` for `element_visible`** (bad JSON) is treated as "checkpoint
  didn't pass," not an uncaught exception — a config bug shouldn't crash a whole replay run when
  a normal `failure` result already carries enough context to debug it (`checkpoint.ts`).
- **A recovery step id that doesn't exist in this artifact** aborts recovery immediately and logs
  why, rather than throwing — recovery failing safely still needs to fall through to the normal
  failure/escalation path.
- **An `extract` step can't be "already satisfied" the way other steps can** on escalation resume
  — there's no checkpoint concept for "did we already read the right value" — so it always falls
  through to a real retry of the extraction itself.
- **A blank required param (`""`) is treated as missing, not provided** — `validateParams()`
  explicitly rejects it before any step runs, because a model that omits a value it isn't sure of
  can otherwise supply an empty string that used to sail through validation and only fail once
  the browser hit a page it couldn't actually use.
- **A risky step's retry after recovery still requires confirmation** — `authorizeAndConfirm()`
  runs on every recovery step and every post-recovery retry, not just the original attempt, so an
  unattended run without `--allow-risky` (or without an `approved` artifact — see
  [`10-confidence-and-approval.md`](10-confidence-and-approval.md)) still blocks correctly even
  mid-recovery.
- **A server-side redirect or in-place re-render after a `POST`** is caught by the post-action
  landed-URL check (`authorizeLandedUrl`), independent of whatever `predictNavigation()` guessed
  before the click.

## Related docs

- [`05-artifact-schema.md`](05-artifact-schema.md) — the typed contract replay executes
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — what `authorizeAndConfirm` and
  `authorizeLandedUrl` actually check
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — the human side of `onEscalate`
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — how `success` vs.
  `business_outcome` vs. `failure` feeds a trust score and an unattended-execution gate
- [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — what the recorded "which locator
  matched" data is later mined for
- [`../REPORT.md`](../REPORT.md) — see "3. Determinism & error handling" and "5. Escalation &
  handoff" for the original design write-up this doc expands on
- [`../README.md`](../README.md) — steps 3, 4, 4b, 4c for the exact commands this doc's examples
  are drawn from
