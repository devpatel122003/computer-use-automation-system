# Assisted Fallback and Vision-Grounded Recovery

## In one sentence

When a deterministic replay step fails for a reason nothing on the artifact already explains,
an operator can opt in to giving the system exactly one phone call to an AI advisor for that
one step — never a conversation, never a second attempt, and never allowed to act on its own
if the advice is genuinely risky.

---

## Part 1 — For everyone: one phone call, not a conversation

### The real-world analogy

Imagine a new employee following a laminated instruction card (that's **replay** — see
[`06-deterministic-replay.md`](06-deterministic-replay.md)): "click the button labeled
Sign On." Normally that's all they need. But say the company rebranded overnight and the
button now says "Log In" instead. The instruction card is suddenly wrong, and the employee
is stuck.

Assisted fallback is giving that stuck employee **one phone call** to a supervisor: "I'm
looking at this exact screen, my instructions say to click 'Sign On,' but I don't see that
anywhere — what do I do?" The supervisor looks at a photo of the same screen and gives back
*one* suggestion: "click the button that says Log In." The employee doesn't get to keep
calling back and riffing with the supervisor about the rest of the task — that one call is
for that one stuck moment, nothing more. And if the supervisor's suggestion is something
irreversible or hard to verify (like "just click roughly there, in that general area"), a
second person still has to sign off before the employee acts on it — the same rule that
applies to any risky action in this system, not a special exception for phone-call advice.

This matters because the whole point of replay is that it's supposed to be fast, cheap, and
never need an AI model to "think" — see
[`00-problem-and-solution.md`](00-problem-and-solution.md). Turning on assisted recovery is
a deliberate, narrow exception to that promise, and it's off by default.

### A concrete worked example, using the real canvas-only fixture

`apps/mock-bank` ships a page built specifically to prove this feature, not to sell a real
banking feature: `/legacy-widget-demo`
(`apps/mock-bank/views/legacyWidgetDemo.ejs`). It draws a "Check Balance" button entirely on
an HTML `<canvas>` — there is no button element, no link, nothing with a name a normal
role-based automation can find. It stands in for the brief's "native desktop application...
the only reliable surface is what a human operator sees and does" case — a screen-shared
legacy terminal, made real enough to actually click, not simulated.

Running `npm run vision-fallback-demo` does exactly what a real replay failure looks like:

1. A "recorded" step tries to click a button named "Check Balance" by role and name — the
   only way a DOM-based recorder ever could describe it. It fails, because there's no such
   DOM element:
   ```
   Recorded (DOM-based) action result: failed (...)
   URL immediately after the failed recorded click: http://localhost:4000/legacy-widget-demo
   ```
2. `attemptAssistedRecovery` is invoked directly, with one real Gemini call, given the step's
   goal, the empty DOM observation, *and* a screenshot of the actual page.
3. Real, checked-in evidence has shown the model correctly recognize there's nothing
   DOM-addressable, correctly propose `click_at_coordinates` instead, get that classified as
   risky (see below for why), get confirmed, and execute — sometimes landing correctly, and
   at least once landing **slightly outside the button's actual bounds**. That's not a bug —
   it's an honest, expected limitation of clicking based on pixel coordinates instead of a
   real, addressable element. It's exactly why this is a last-resort fallback, not something
   you'd rely on as your primary way of automating a task.

### "What happens if...?"

| Situation | What happens |
|---|---|
| Assisted recovery isn't turned on (the default) | Replay behaves exactly as it always has — a failed step is just reported as a `failure`. No model is ever called. |
| A checkpoint fails (the page doesn't show what it's supposed to show after a step) | Assisted recovery is never tried here — a checkpoint failure is a fuzzier signal than "this button doesn't exist," so it's excluded on purpose. |
| An `extract` step fails (reading a piece of data off the page) | Also excluded on purpose — there's no "corrective click" that fixes a data-extraction problem, so offering one would be pointless. |
| The model proposes clicking a real button by name and it works | The step succeeds and is logged as an assisted-recovery action, distinct from a normal recorded step — see below. |
| The model proposes a coordinate click (e.g. the canvas-only fixture) | It's always classified `risky`, regardless of how confident the model sounds, and goes through the same confirm-or-decline flow as any other risky action. |
| Nobody is available to confirm a risky proposal (e.g. an unattended API call) | It's declined automatically, and the original failure is reported — same as if assisted recovery had never run. |
| The model's advice, once executed, still doesn't work (e.g. the coordinate click misses) | The step is reported as failed, same as if there'd been no assisted recovery — the system doesn't pretend it worked. |
| The AI advisor itself is unreachable (rate-limited, or briefly down) | The system reports the *original* failure rather than crashing — a flaky "advisor" is never allowed to make things worse than not calling one at all. |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief's own wording (§8, "Assisted fallback"): *"on replay failure, allow a bounded,
policy-checked LLM recovery for a single step (never open-ended), and record it as
evidence."* Replay's core selling point is that it makes **zero** model calls — see
[`06-deterministic-replay.md`](06-deterministic-replay.md). Assisted recovery is a
deliberate, narrow, opt-in exception, not a redesign of that promise:

- It's **off unless explicitly enabled** — `ReplayOptions.assistedRecovery`, wired to
  `replay --assisted-recovery true` on the CLI. Every existing caller of `replay()` gets the
  exact same zero-model-call behavior it always had unless it explicitly opts in.
- It's **never** offered for a checkpoint failure. A checkpoint is a fuzzier signal ("the
  page doesn't look like it's supposed to") than a mechanical action failure ("this element
  did not resolve at all"), and handing a model a fuzzy signal to freelance around is a much
  bigger judgment call than handing it a precise one.
- It's **never** offered for an `extract` step. Recovery's vocabulary (click / type /
  select_option / click_at_coordinates) has nothing that could plausibly fix a failed data
  read — there's no "corrective click" for "I couldn't read this field."
- Coordinate-clicking is **always classified `risky`**, never given a blanket refusal. See
  "Why coordinate risk is not a blanket refusal" below — this was a real, deliberate
  correction made while building the feature.

### What

`src/replay/assisted-recovery.ts` exports `attemptAssistedRecovery()`, called from the
replay engine on a mechanical step failure that assisted recovery is enabled for. It:

1. Takes a fresh `Surface.observe()` snapshot and a `Surface.screenshot()` of the current
   live page.
2. Sends **one** Gemini call (via `withModelFallback`, the same transient-failure/
   daily-quota-fallback resilience every other Gemini call in this repo uses) with:
   - the step's own `description` (its goal),
   - the failure context (why the recorded action didn't work),
   - the current text observation (`formatObservation`),
   - the screenshot, as an inline image part.
3. Offers **four** tools, forced to pick exactly one
   (`functionCallingConfig.mode: ANY`):
   - `click`, `type`, `select_option` — same semantics as a recorded step's action type, but
     targeting whatever element on the *current* page resolves by accessible role + name.
   - `click_at_coordinates` — click a raw pixel coordinate in the screenshot, for surfaces
     with no accessible role/name at all (a `<canvas>`, or anything else purely visual).
4. Resolves the model's chosen tool call into a real `Action` (`resolveRecoveryAction`).
5. Runs the **exact same** `GuardrailsPolicy.authorize()` check any other action goes
   through. If it's outright blocked, recovery stops there. If it's `risky`, it goes through
   the caller-supplied `onRiskyStep` callback — the identical contract
   `ReplayOptions.onRiskyStep` already has — declining by default if none is wired up.
6. Executes via `surface.perform()` and logs the outcome to evidence with
   `assistedRecovery: true` in the detail, so it's visibly distinguishable from a normal
   recorded step in the run's JSONL log.

```typescript
export async function attemptAssistedRecovery(params: {
  config: AssistedRecoveryConfig;
  surface: Surface;
  policy: GuardrailsPolicy;
  logger: EvidenceLogger;
  step: ArtifactStep;
  stepNum: number;
  failureContext: string;
  onRiskyStep?: (ctx: { step: ArtifactStep }) => Promise<boolean>;
}): Promise<AssistedRecoveryOutcome>
// AssistedRecoveryOutcome = { recovered: boolean; reasoning?: string; note: string }
```

Deliberately **not** built: promoting a successful assisted action into a new candidate
locator on the artifact itself. A single lucky model guess silently becoming part of a
production artifact is a real risk that deserves human review as its own step — see
`REPORT.md` — not an automatic side effect of one successful recovery.

### How — DOM tools vs. the vision tool are one call, not two mechanisms

A real design tension surfaced while building this: the brief's "no accessibility info at
all" case (a canvas widget, a screen-shared terminal) and the "a rebranded label broke the
recorded locator" case are different *reasons* a step fails, but the *same shape* of
problem — the recorded locator doesn't resolve, and something else on the current page
satisfies the goal. Rather than building a second, parallel "vision fallback" module that
duplicates the entire call/authorize/execute/log skeleton, both grounding strategies are
offered to the model in the *same* call, as two kinds of tools; the model itself decides
which one the actual page supports.

### Why coordinate risk is not a blanket refusal

A coordinate click's destination can never be verified in advance — there's no DOM to
inspect, by definition, so `GuardrailsPolicy.authorize()` classifies `click_coordinates` as
always `risky` (see [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) for the general
risk model). The first version of this module had a blanket "never auto-execute anything
risky" rule. That sounds safe, but it has a real consequence: it makes `click_at_coordinates`
**permanently inert**, since it can never be anything *but* risky. That's conflating two
different kinds of risk — "an unattended write nobody reviewed" versus "an action nobody
*could* pre-verify, regardless of how careful anyone is." The fix was to stop treating those
the same way: a coordinate-click proposal now goes through the *identical*
`onRiskyStep` contract every other risky action already has, rather than a special-cased
refusal — the existing contract, applied consistently, not a new exception carved out for
this feature.

### Where

- `src/replay/assisted-recovery.ts` — the whole feature.
- `src/replay/replay-engine.ts` — the caller, on a mechanical action failure with
  `assistedRecovery` enabled.
- `src/cli/vision-fallback-demo.ts` — a standalone script that manufactures the DOM failure
  against `/legacy-widget-demo` and calls `attemptAssistedRecovery` directly, real Gemini
  call included, auto-approving the risky confirmation for the demo (a real CLI would prompt,
  same as `src/escalation/controller.ts`).
- `apps/mock-bank/views/legacyWidgetDemo.ejs` / `legacyWidgetConfirmed.ejs` — the
  canvas-only negative-control fixture: a `<canvas>`-drawn "Check Balance" button with a
  click listener that checks pixel bounds and navigates to `/legacy-widget-demo/confirmed`,
  which renders a "Balance check confirmed." banner. There is deliberately no DOM element for
  the button itself.
- `src/agent/model-retry.ts` — `withModelFallback`, shared by discovery, the conversational
  planner, and this module, for transient-error retry and daily-quota model fallback.

### A worked technical example (real command, real shape of output)

```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/_negative-control-url-only.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}' \
  --assisted-recovery true
```

This deliberately points the *unmodified* base artifact at the rebranded `northgate-cu`
tenant with no locator overrides applied, so several steps genuinely fail to resolve (the
submit button says "Log In," not "Sign On"). Real, checked-in evidence has shown the model
correctly recognize "the submit button is labeled 'Log In' instead of 'Sign On'" and recover
the step for real — and, on a separate run, hit a transient Gemini 503 partway through that
degraded gracefully back to reporting the original failure, rather than crashing the whole
replay.

### Edge cases & failure modes

- **Checkpoint failures and `extract` steps** never reach this module at all — excluded at
  the call site in the replay engine, not filtered inside `attemptAssistedRecovery`.
- **Model returns no function call** — treated as `recovered: false`, logged, original
  failure stands.
- **Model proposes an element that doesn't resolve** (`findElement` returns nothing) —
  same: `recovered: false`, the specific `role`/`name`/`nth` it tried to match is logged for
  diagnosis.
- **Model call itself fails** (rate limit, 5xx, after `withModelFallback` exhausts retries) —
  caught explicitly; degrades to "didn't recover" rather than throwing and crashing the
  overall replay run. This is deliberately *not* retried again by this module (unlike the
  discovery loop's own `withRetry`) — it's meant to be one bounded attempt, not a resilient
  loop; a caller who wants another attempt can invoke replay again.
- **Guardrails outright blocks the proposed action** (not just "risky," but disallowed) —
  logged as an escalation-phase event, `recovered: false`, no execution attempted.
- **Risky proposal with no `onRiskyStep` wired up** (e.g. the unattended capability API never
  passes one — see [`14-capability-api.md`](14-capability-api.md)) — declined by default,
  same as the main replay path's own default.
- **Pixel-level miss** — a real, observed outcome: the model correctly identifies the target
  and correctly proposes coordinates, but the click lands slightly outside the button's true
  bounds. Reported honestly as a failed recovery, not silently retried or fudged.

## Related docs

- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the replay engine this module
  is a bounded exception inside
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the risk classification and
  confirmation contract this module reuses rather than special-casing
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — the human-handoff pattern
  this module's `onRiskyStep` contract mirrors
- [`14-capability-api.md`](14-capability-api.md) — the unattended caller that never wires up
  `onRiskyStep`, so a risky recovery proposal is always declined there
- [`REPORT.md`](../REPORT.md) — "Assisted fallback" section, the full design narrative and
  real evidence log
