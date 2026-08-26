# Escalation & Handoff

## In one sentence

When the automation genuinely can't proceed safely on its own, it pauses on the exact live
browser window it was already using, calls a human over to that same screen, and — for
either discovery or replay — can pick back up where it left off once the human hands control
back, instead of starting over or quietly guessing.

---

## Part 1 — For everyone: calling a supervisor over to the same screen

### The real-world analogy

Picture a new hire at a bank branch, trained to handle routine requests at a teller station.
Most of the time they don't need help. But every so often something comes up that isn't in
their training: a customer's account is flagged in a way they're not authorized to touch, or
the screen shows a confirmation pop-up they've never seen before. The right move isn't to
guess, and it isn't to hang up on the customer and start the call over from scratch. It's to
wave a supervisor over to the **same terminal**, let the supervisor look at the **same
screen** the trainee was looking at, let the supervisor do whatever needs doing, and then step
back and let the trainee continue from there.

That's exactly what this system does. It is deliberately *not* a written note ("member 99999
is denied, please advise") handed to a supervisor in another room while the trainee's screen
goes blank. It's the supervisor walking up to the same desk, looking at the same browser
window, taking action in it themselves, and then handing the keyboard back.

### Why "same session" matters so much

If the human were instead handed a description of the problem and asked to fix it "somewhere
else," you'd lose everything that made the run coherent: which member is loaded, whether the
operator is still signed on, which page of a multi-page form is showing, any state the
back-office software keeps server-side and ties to that one browser session/cookie. Re-doing
all of that from scratch is slow, and worse, it's not guaranteed to reach the exact same state
that was actually stuck. This system keeps the human and the automation pointed at the
identical, still-open browser tab the whole time.

### A concrete walkthrough: member 99999 (discovery)

This is a real run from this repo (`npm run escalation-resume-demo`,
`src/cli/escalation-resume-demo.ts`), goal: *"Sign on as operator demo_operator, look up
member 99999, and open a new Savings sub-account for them with an initial deposit of $100."*

1. Discovery signs on, searches for member `99999`, and the mock bank correctly reports
   **permission denied** — a real, everyday condition (this staff member simply isn't
   authorized for this particular account), not a bug.
2. The discovery model itself recognizes this isn't something it can route around by trying
   again or picking a different button — it calls its own `escalate` function.
3. The system pauses, takes a screenshot of the live page, writes an intervention record, and
   prints:
   ```
   === HUMAN INTERVENTION REQUESTED ===
   Capability: open-sub-account
   Reason: <the model's own explanation of why it's stuck>
   Current URL: http://localhost:4000/members/99999
   Screenshot: evidence/runs/<runId>/screenshots/intervention-1.png
   The browser window is live -- take manual action in it now.
   Press [Enter] to hand control back to automation, or type 'abort' + Enter to stop the run.
   ```
4. A human operator can't fix "permission denied" on the server, but they *can* redirect the
   same open browser tab to a member they're actually allowed to serve. In this demo that
   operator action is scripted (disclosed in the script's own header comment, since this
   process has no mouse to hand a real person) — it navigates the same `Page` to
   `http://localhost:4000/members/10001` — but everything after that is real.
5. The human signals **resume**. Discovery doesn't assume anything about what changed; it
   **re-observes** the page from scratch, notices it's now looking at member 10001's page,
   and — without being told step-by-step — picks "Savings," types the deposit, submits, and
   reaches a real confirmation. The actual logged result:
   ```
   Discovery finished with status: finished
   Summary: Successfully escalated when member 99999 was denied, and upon return, opened a new
   Savings sub-account for member 10001 with an initial deposit of $100. Confirmation SA-00001
   displayed.
   ```

### A concrete walkthrough: member 77777 (replay)

Discovery isn't the only place this happens. `npm run escalation-resume-replay-demo`
(`src/cli/escalation-resume-replay-demo.ts`) shows the same idea on the *replay* side — the
production execution path, where there's normally no AI and no human in the loop at all.

The recorded `open-sub-account` artifact was never taught about member `77777`, one of the
mock bank's special test members (`requiresInterstitialConfirmation` in
`apps/mock-bank/src/data.ts`): opening a sub-account for this member shows an unexpected
"are you sure?" interstitial page instead of going straight to the confirmation screen. Replay
gets to step 10 ("click Submit"), checks whether it landed on the confirmation page as
recorded, and it hasn't — a genuine, unanticipated deviation, not one of the outcomes the
artifact already knows about. From the real evidence at
`evidence/runs/replay-2026-08-26T00-40-07-082Z/log.jsonl`:

```json
{"step":10,"phase":"checkpoint","summary":"Checkpoint for step-10: failed", "detail":{"checkpoint":{"kind":"url","expr":"/members/{memberId}/sub-accounts/*/confirm","description":"Reached the sub-account confirmation page."}}}
{"step":10,"phase":"escalation","summary":"Intervention requested: Checkpoint failed at step-10: Reached the sub-account confirmation page."}
{"step":10,"phase":"escalation","summary":"Operator resolved intervention with: resume"}
{"step":10,"phase":"checkpoint","summary":"Post-escalation checkpoint recheck for step-10: already satisfied"}
```

A scripted stand-in for a human operator clicks the interstitial's "Confirm & Continue"
button on that same live page — again disclosed as scripted, since there's no real mouse
here. But look at what happens next: instead of blindly retrying step 10's own "click Submit"
action (which would try to submit a form that's no longer even on screen, or double-submit
one that already went through), replay **re-checks step 10's own checkpoint first**. It's
already satisfied — the human's click already moved things forward — so replay treats the
step as done and continues to extraction and the success checkpoint, reaching a real
confirmation number, `SA-00001`, and finishing with `status: "success"`.

### Why the recheck-before-retry matters

If replay just re-ran "click Submit" after every resume without checking first, a human who
already cleared the obstacle by hand would risk a **duplicate action** — resubmitting a form,
double-clicking a button that only tolerates one click, opening two sub-accounts instead of
one. Checking the checkpoint first means: "did the human's fix already get us to where this
step needed to land? If so, don't touch anything else." Only if the checkpoint still doesn't
hold does replay retry the step's own recorded action once.

### The bug that was found and fixed

While building the replay-side resume path above, a real, previously-invisible bug surfaced
in how "no answer" was handled. The escalation prompt asks the human to either press **Enter**
(resume) or type **`abort`**. A blank Enter and "nobody was there to answer at all" both used
to come back from the terminal-reading code as the *same* empty string — which meant a
run whose terminal input was closed (e.g. an unattended script, or a pipe that ended without
ever typing anything) would look *identical* to a human deliberately pressing Enter to
resume, and would have **silently resumed an escalation nobody ever actually reviewed**. That
is close to the worst possible failure mode for a human-in-the-loop safety mechanism: the
"human in the loop" step just gets skipped, silently, and the run keeps going as if someone
had signed off on it.

The fix: the low-level prompt function now returns `null` specifically when the input stream
closes with no answer possible, which is a different value from a real (even blank) answer.
The decision logic that reads that value now explicitly treats `null` the same conservative
way it already treats an explicit "abort": stop, don't resume. Only a real answer that isn't
"abort" resumes the run.

### "What happens if...?" — real scenarios

| Situation | What happens |
|---|---|
| Member `99999` (permission denied) comes up during discovery | The model calls `escalate` itself; a human redirects the same browser tab to a member they can actually serve; discovery re-observes and finishes the goal against the new member. |
| Member `77777` (unexpected confirmation interstitial) comes up during replay | Replay's step-10 checkpoint fails with nothing in `knownOutcomes` to explain it; a human clicks through the interstitial on the same page; replay rechecks the checkpoint (already satisfied) and completes without re-clicking Submit. |
| A step requires a real, hard-to-undo action (opening the account) | Guardrails pause for explicit `yes`/anything-else confirmation *before* the risky step executes — a related but separate mechanism (`confirmRiskyAction`), not an escalation from failure. |
| The human types `abort` instead of pressing Enter | The run ends immediately with a logged `abort` decision — no further steps are attempted. |
| The terminal's input stream is closed (no human is actually there — e.g. `/dev/null` piped in, or a script with nothing left to send) | Treated as `abort`, exactly like a typed "abort" — never silently treated as "resume." This is the fix described above. |
| The exact same step fails again immediately after a human already tried once | No second escalation prompt — the step hard-fails for real. One escalation attempt per step, so a systemically broken step surfaces as a real failure a human can debug properly, instead of looping on repeated prompts. |
| An unattended caller (the capability API, a canary check) hits a hard failure | No prompt appears at all — `onEscalate` is simply not wired up for those callers (`--interactive-escalation` is off by default), so a failure fails immediately rather than hanging forever waiting for a human who was never going to show up. |
| The human's manual fix lands the page outside where the artifact is allowed to go | Blocked — the allowlist is re-checked on the landed URL after a resume, exactly like every other landing site in replay; a human's own navigation is not exempt from the guardrail. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Three real triggers can leave the system unable to proceed safely, all named in the brief and
all real in this codebase (not simulated):

1. The **discovery model itself** decides, mid-run, that it's stuck in a way the goal alone
   doesn't resolve (an error state, ambiguity, a repeated-action dead end) and calls its own
   `escalate` function.
2. A guardrail-classified **`risky`** step (a write action that can't easily be undone) always
   requires explicit confirmation before it executes, in both discovery and replay.
3. A **replay hard failure** — nothing in the artifact's `knownOutcomes` explains a deviation,
   and assisted recovery either wasn't configured or didn't help.

The engineering problem this doc covers is #1 and #3's *resume* path specifically: how do you
hand a live, stateful browser session to a human without losing anything, and how do you
safely resume mechanical execution afterward without either replaying an already-done action
or assuming state you haven't actually re-verified?

### What

- `src/escalation/types.ts` — the three small shared shapes:
  - `InterventionRequest { id, runId, runType, capability, step, reason, screenshotPath, url, createdAt }`
  - `InterventionDecision = "resume" | "abort"`
  - `CapturedHumanAction { type: "navigation", detail, ts }` — currently only navigations are
    captured as evidence of what the human did.
- `src/escalation/controller.ts` — `EscalationController`, the real (not mocked) handoff
  mechanism, and `resolveInterventionDecision(answer: string | null): InterventionDecision`,
  the pure decision function extracted specifically so it's directly unit-testable without a
  real `Page`.
- `src/escalation/prompt.ts` — `promptLine(query, input?, output?): Promise<string | null>`,
  the low-level terminal prompt.
- `src/replay/replay-engine.ts` — `ReplayOptions.onEscalate`, `tryEscalate`,
  `resumeAfterEscalation`, `MAX_ESCALATION_ATTEMPTS_PER_STEP` (= `1`): replay's own resume
  capability, layered onto the same three-way outcome contract (`success` /
  `business_outcome` / `failure`).
- `src/cli/replay.ts` — the `--interactive-escalation true` flag that wires
  `EscalationController.requestIntervention` into `onEscalate` for a human at a real terminal;
  omitted by default for the same reason `--assisted-recovery` is opt-in — the capability API
  and canary checks have no human to hand a stuck run to.
- `src/cli/escalation-resume-demo.ts` / `src/cli/escalation-resume-replay-demo.ts` — real,
  runnable, checked-in demonstrations of both resume paths, each disclosing exactly which one
  step is scripted (there's no real mouse in this process) versus what's genuinely real.

### How

**Control transfer.** The browser runs **headed** specifically so this is literal, not a
simulation of a handoff: `EscalationController` tracks a private
`controller: "automation" | "human"` flag. `requestIntervention()` takes a screenshot,
writes a structured `intervention-N.json` file and a `phase: "escalation"` log line via
`EvidenceLogger`, flips `controller` to `"human"`, and attaches a `framenavigated` listener on
the page's main frame that records every navigation the human makes as a `CapturedHumanAction`
— evidence of what actually happened during their turn, not just that some turn happened.
Then it calls `promptLine("> ")` and blocks. On any answer, the listener is detached,
`controller` flips back to `"automation"`, and `resolveInterventionDecision(answer)` maps the
raw string to `"resume" | "abort"`:

```ts
export function resolveInterventionDecision(answer: string | null): InterventionDecision {
  return answer === null || answer.trim().toLowerCase() === "abort" ? "abort" : "resume";
}
```

**Why `promptLine` returns `string | null`, not just `string`.** `readline`'s own
promise-based `question()` never settles if the input stream closes before an answer is
typed — with a live Playwright browser still open keeping other handles alive, the process
would hang forever, which is worse than failing. `promptLine` (using the callback-based
`readline` module, not `readline/promises`, specifically to avoid a real microtask-ordering
race between a `line` event and a `close` event that was found while fixing this) resolves
`null` the moment the stream closes with nothing typed. `null` and `""` (a real, deliberate
blank Enter) are **not the same thing**, and `resolveInterventionDecision` must not collapse
them — a blank Enter is a human's real "go ahead, resume" signal; a closed stream is nobody
answering at all. Before this fix, both produced the same empty string, and
`requestIntervention()` had no way to tell "no one was there to review this" apart from "a
human reviewed it and said resume" — silently resuming a run nobody vetted. The fix keeps the
conservative default `confirmRiskyAction` already used (no answer → treat as declined/abort)
consistent across both call sites, now that the two "empty" cases are distinguishable.
`confirmRiskyAction`'s own check, `(answer ?? "").trim().toLowerCase() === "yes"`, was already
correct either way, since `null` and `""` are both "not yes" — but it's now written with the
`??` explicit, for clarity, rather than by accident.

**Resume: discovery.** `resume` re-enters `DiscoveryAgent`'s observe → decide → act loop with
a function-response telling the model a human just acted. Discovery deliberately
**re-observes** rather than assuming it knows where the human left the page — this is what
makes "same session, not a fresh one" actually true instead of aspirational. In the member
`99999` demo, the model isn't told "you're now on member 10001's page" — it just looks, and
figures that out itself, the same way it figures out any other page.

**Resume: replay (the newer path).** `tryEscalate` is the single call site for offering a
human a chance to save a step that's about to hard-fail — from either a mechanical action
failure or a checkpoint failure:

```ts
async function tryEscalate(ctx, step, stepNum, escalationAttempt, reason, fallback) {
  if (!ctx.onEscalate || escalationAttempt >= MAX_ESCALATION_ATTEMPTS_PER_STEP) {
    return { outcome: "failure", result: fallback };
  }
  const decision = await ctx.onEscalate({ step, stepNum, reason });
  if (decision !== "resume") return { outcome: "failure", result: fallback };
  return resumeAfterEscalation(ctx, step, stepNum, escalationAttempt + 1);
}
```

`resumeAfterEscalation` is the piece that's genuinely new compared to discovery's resume: it
**re-checks the step's own checkpoint directly against the live page first**, before
retrying anything:

```ts
async function resumeAfterEscalation(ctx, step, stepNum, escalationAttempt) {
  if (step.checkpoint && step.actionType !== "extract") {
    const checkpointOk = await evaluateCheckpoint(ctx.surface, step.checkpoint, ctx.params);
    if (checkpointOk) {
      const landed = ctx.policy.authorizeLandedUrl(ctx.surface.currentUrl());
      if (!landed.allowed) return { outcome: "failure", result: { status: "failure", ... } };
      return { outcome: "success" };
    }
  }
  return executeStep(ctx, step, stepNum, MAX_RECOVERY_ATTEMPTS_PER_STEP, escalationAttempt);
}
```

If the checkpoint already holds — the human did the step's actual work by hand, or the
mechanical action had already fired and only the checkpoint hadn't settled yet — the step is
marked done, after the same allowlist re-check every other landing site in the replay engine
applies (a human's navigation is a real navigation too, not exempt from where it's allowed to
go). Only if the checkpoint still doesn't hold, or the step is an `extract` (there's no
"already done" concept for reading a value), does it fall through to a real retry of the
step's recorded action, via a recursive call into `executeStep` — capped by
`MAX_RECOVERY_ATTEMPTS_PER_STEP` so it can't loop.

**The one-attempt cap.** `MAX_ESCALATION_ATTEMPTS_PER_STEP = 1`, same reasoning as
`MAX_RECOVERY_ATTEMPTS_PER_STEP`: if the exact same step still fails immediately after a
human already intervened once, that's a systemic problem a second prompt won't fix — better
to hard-fail cleanly than trap a human in a re-prompt loop.

### Where

- `src/escalation/controller.ts`, `prompt.ts`, `types.ts` — the shared handoff mechanism.
- `src/replay/replay-engine.ts` — `tryEscalate`, `resumeAfterEscalation`, both call sites
  (mechanical-action-failure and checkpoint-failure) that invoke `tryEscalate`.
- `src/cli/replay.ts` — `--interactive-escalation` flag wiring.
- `src/agent/discovery-agent.ts` — discovery's own resume-and-continue control flow (see
  [`04-discovery-agent.md`](04-discovery-agent.md)).
- `src/cli/escalation-resume-demo.ts`, `src/cli/escalation-resume-replay-demo.ts` — runnable
  real evidence for both paths.
- `src/escalation/controller.test.ts` and `src/escalation/prompt.test.ts` — direct unit
  coverage for `resolveInterventionDecision` and `promptLine`'s stream-closure behavior,
  since both are pure/near-pure logic; the real browser handoff itself is verified by the two
  demo scripts' checked-in evidence, not mocks.

### A worked technical example

```bash
curl -s -X POST http://localhost:4000/__test__/reset
npm run escalation-resume-replay-demo
```

Real log excerpt from `evidence/runs/replay-2026-08-26T00-40-07-082Z/log.jsonl`:

```json
{"step":10,"phase":"checkpoint","summary":"Checkpoint for step-10: failed"}
{"step":10,"phase":"escalation","summary":"Intervention requested: Checkpoint failed at step-10: Reached the sub-account confirmation page."}
{"step":10,"phase":"escalation","summary":"Operator resolved intervention with: resume"}
{"step":10,"phase":"checkpoint","summary":"Post-escalation checkpoint recheck for step-10: already satisfied"}
{"step":11,"phase":"act","summary":"Performed extract (step-11): ok"}
{"step":12,"phase":"outcome","summary":"Replay succeeded","detail":{"outputs":{"confirmationNumber":"SA-00001"}}}
```

And the run's final `replay-result.json`:

```json
{
  "status": "success",
  "runId": "replay-2026-08-26T00-40-07-082Z",
  "outputs": { "confirmationNumber": "SA-00001" }
}
```

To see the unattended default hold even for this new path, pipe closed stdin at the same
scenario instead of running the interactive demo:

```bash
curl -s -X POST http://localhost:4000/__test__/reset
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"77777","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true --interactive-escalation true < /dev/null
```

This correctly reports the original checkpoint failure rather than hanging, or — before the
`promptLine` fix described above — silently resuming as if a human had reviewed it.

### Edge cases & failure modes

- **Re-entrant escalation.** `requestIntervention()` defensively refuses (`abort`, plus a
  logged error) if called while `controller` is already `"human"` — in this single-process
  design the caller always awaits the previous call first, so this is a belt-and-suspenders
  check against a future bug, not a reachable path today.
- **Screenshot failure during intervention.** Caught and logged as a `phase: "error"` event;
  does not block the intervention itself from proceeding.
- **A human navigates around during their turn but never actually fixes anything.** The
  `framenavigated` listener still records every navigation as evidence, but nothing forces
  the checkpoint to actually hold afterward — `resumeAfterEscalation` will fall through to
  retrying the step's own action, and if that still fails, the step hard-fails for real (one
  attempt spent).
- **A closed stdin at an unattended `--interactive-escalation true` invocation.** Resolves to
  `abort` via `promptLine`'s `null`, not a hang and not a silent resume — the scenario the
  bug fix above specifically targets.
- **Extract steps can't use the "checkpoint already satisfied" shortcut** — there's no
  checkpoint concept for "did we already read the right value," so an `extract` step always
  falls through to a real retry after a resume.
- **A human's fix lands the page outside the artifact's allowlist.** Reported as a `failure`
  result (`"landed URL within allowlist after human intervention"`), not silently accepted —
  see [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md).

## Related docs

- [`01-system-design.md`](01-system-design.md) — where escalation fits among the other pieces
- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the three-way replay contract
  (`success` / `business_outcome` / `failure`) that a replay hard failure falls into before
  escalation gets a chance to save it
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the allowlist and risky-action
  confirmation gate that `confirmRiskyAction` is part of, separate from failure-driven escalation
- [`09-evidence-and-logging.md`](09-evidence-and-logging.md) — how every intervention, decision,
  and screenshot described here actually gets written down
- [`REPORT.md`](../REPORT.md) — "5. Escalation & handoff" section, the original design write-up
- [`SECURITY.md`](../SECURITY.md) — how secrets are kept out of everything logged during an
  escalation
