# The Discovery Agent

## In one sentence

The discovery agent is the loop that puts an AI model (Gemini) in the driver's seat of a live
`Surface` exactly once per task — observe the screen, decide one action, act, log why — until
it either finishes the goal, gets stuck and asks for a human, or gives up.

---

## Part 1 — For everyone: watching the AI learn a task

### The analogy

Think of training a brand-new bank teller on a piece of software they've never touched, by
having them narrate out loud as they go: "OK, I see a box labeled Operator ID, I'll type the
username there... now I see a Password box, I'll type the password... now there's a Sign On
button, I'll click that..." A trainer standing behind them isn't just watching what they
click — they're also writing down *why* each click happened, so that later, someone else can
follow the same steps without needing to re-explain the reasoning.

That's exactly what the discovery agent does, except the "new teller" is Google's Gemini model,
and the "trainer taking notes" is this project's evidence logger. The model never gets to see
raw HTML or a screenshot pixel-by-pixel — it only ever sees the same kind of flattened list of
labeled elements described in [`03-surface-abstraction.md`](03-surface-abstraction.md), and on
every single turn it's required to pick exactly one action and say, in one sentence, why.

### A real, end-to-end walkthrough

This is the actual default goal `npm run run-agent` runs (from `README.md`'s Demo path, step
2): *"Sign on as operator demo_operator / demo_password, look up member 10001, open a new
Savings sub-account with an initial deposit of $100, and reach the confirmation screen."*
Here's what actually happens, turn by turn:

1. **Navigate.** The loop starts by directly navigating to `http://localhost:4000/login` —
   this first step isn't a model decision, it's just how the run begins.
2. **Observe → decide → act:** the model sees the Operator ID box, Password box, and Sign On
   button; it types `demo_operator`, types `demo_password`, and clicks Sign On.
3. **Observe → decide → act:** now on the member search page, it types `10001` into the Member
   ID box and clicks Look Up Member.
4. **Observe → decide → act:** on member 10001's page, it clicks "Open New Sub-Account."
5. **Observe → decide → act:** on the new sub-account form, it explicitly selects "Savings"
   from the Account Type dropdown (the system prompt requires this even if Savings already
   shows as the default — see "Rules" below), then types `100` into the Initial Deposit box.
6. **Observe → decide → act, but paused:** the model decides to click Submit. Because that
   click is a `POST` to `/members/10001/sub-accounts` — a real, hard-to-undo write — guardrails
   classify it `risky` and the run pauses in the terminal:
   ```
   === RISKY ACTION REQUIRES CONFIRMATION ===
   POST /members/10001/sub-accounts is classified risky and requires confirmation.
   Type 'yes' to proceed, anything else to decline:
   ```
   A human types `yes`, and the click actually happens.
7. **Observe → decide:** the model sees the confirmation page (a real confirmation number,
   e.g. `SA-00004`), extracts it, and calls `finish`.
8. The run ends with `status: "finished"`, and everything just described gets turned into a
   reusable artifact — see [`05-artifact-schema.md`](05-artifact-schema.md).

### "What happens if...?" — real scenarios

| Situation | What happens |
|---|---|
| The model tries to click a button that isn't actually on the current page (it hallucinated an element) | The action is rejected with "No element found matching role=... name=... nth=...", logged, and counted toward a repeated-failure limit — it does *not* silently retry forever. |
| The model repeats the exact same failing action three times in a row | The loop stops itself with status `dead_end`, rather than burning through all 20 steps on something that's clearly not working. |
| The model sees an error banner it doesn't recognize, or gets denied access | It's instructed to call `escalate` with a plain-language reason instead of guessing — see [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) for what happens next. |
| The goal is already met (confirmation screen visible) | The model is told, in the system prompt, to call `finish` immediately and *not* take any extra actions — so a finished run doesn't wander off and accidentally do something else. |
| The account-type dropdown already defaults to the right value | The model is still required to explicitly select it — an unexercised default isn't proof the field can be *set*, which matters once this becomes a reusable capability for a caller who might request a different account type. |
| The model runs out of its step budget (20 turns) without finishing | The run ends with status `max_steps` — no artifact gets recorded, because only a `finished` run can become one. |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief asks for a system that uses "computer use" to accomplish a goal against a live UI
*the first time*, by observing state, deciding, acting, and repeating until done or stuck. The
engineering problem isn't "can an LLM click buttons" — it's making that loop **bounded,
observable, and honest about when it's stuck**, so that a finished run is actually trustworthy
enough to become a reusable artifact, and a stuck run is caught immediately rather than
producing a plausible-looking but wrong artifact.

### What

`DiscoveryAgent` (`src/agent/discovery-agent.ts`) runs a single method, `run(goal, startUrl)`,
implementing:

```
observe() -> format observation -> Gemini function-call (exactly one action) ->
  guardrail check -> perform() -> log -> repeat
```

until one of five `DiscoveryStatus` values (`src/agent/types.ts`) is reached:
`"finished" | "escalated" | "max_steps" | "dead_end" | "error"`.

### How

**One action per turn, forced.** Every call to `genai.models.generateContent()` passes
`toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } }` — this forces
Gemini to return exactly one function call every turn, never plain text and never zero calls.
That's what makes the loop's control flow deterministic: there is always exactly one action to
authorize and execute, never an ambiguous "the model said several things."

**The tool schemas** (`src/agent/tool-schemas.ts`, `DISCOVERY_TOOLS`) declare seven functions:
`navigate`, `click`, `type`, `select_option`, `extract`, `finish`, `escalate`. Each targeting
tool (`click`/`type`/`select_option`/`extract`) takes `role`, `name`, and an optional `nth` for
disambiguating duplicates — the same shape `findElement()` (`src/agent/observation-format.ts`)
uses to look the element back up in the current `StateSnapshot`.

**The `reasoning` field trick.** Forcing a function call every turn means Gemini never emits an
accompanying free-text explanation alongside the call — there's nowhere for a "why" to live
unless it's part of the structured call itself. Every action tool's schema starts with a shared
`REASONING_FIELD`:

```ts
const REASONING_FIELD = {
  reasoning: {
    type: Type.STRING,
    description: "One brief sentence: why this specific action, right now, moves toward the goal.",
  },
};
```

listed as the tool's *first* declared, *required* property — nudging the model to articulate
its justification before committing to the action, for the same reason chain-of-thought
prompting asks for reasoning before an answer. `finish` and `escalate` don't need it separately
since their own `summary`/`reason` fields already carry the "why." The result: every
`"phase":"decide"` line in the evidence log carries a real one-sentence rationale, not just a
tool name and arguments.

**The system prompt's rules** (the `SYSTEM_PROMPT` constant) are short and specific, not a
general "be a good agent" pep talk:
- Only reference elements present in the *current* observation, by exact role/name (+`nth` for
  duplicates).
- If the goal specifies a dropdown value, call `select_option` for it explicitly — even if it's
  already the default — because "never actually exercised" isn't the same guarantee as "can be
  set" for a future caller of this capability.
- Use `extract` for anything the goal asks to be read back.
- Call `finish` the moment the goal's target state is visible; don't take extra actions after.
- If an error banner, permission-denied message, unresolvable validation error, or a repeated
  failure shows up, call `escalate` with a clear reason instead of guessing.
- Never invent data — only report what `extract` actually returned.

**Stopping conditions**, each a distinct, logged event:
- **`finish`** — the model reports the goal is met; `finalSummary` is recorded from its
  `summary` argument.
- **`escalate`** — the model calls `escalate` with a `reason`. The caller's `onEscalate`
  callback decides `"resume"` or `"abort"`. On resume, the loop injects a synthetic
  `functionResponse` telling the model "a human operator took over... re-observe and continue,"
  and the loop keeps going from the next observation — the same live session, not a restart.
  On abort, status becomes `"escalated"` and the loop ends.
- **Repeated-failure dead-end** — `actionSignature(toolName, input)` builds a stable signature
  (tool name + a deterministically-sorted-key JSON stringify of its args, deliberately
  *excluding* `reasoning`, since the model rephrases its justification slightly even when
  retrying the logically identical action). If the same signature fails
  `REPEATED_FAILURE_LIMIT` (3) times in a row — whether the failure was "element not found" or
  a mechanical `perform()` failure — status becomes `"dead_end"`.
- **`max_steps`** — the loop runs at most `DEFAULT_MAX_STEPS` (20) turns; if none of the above
  triggered by then, the run ends with status `"max_steps"` and (correctly) no artifact.
- **`error`** — defensive: the model's response contained no function call at all (shouldn't
  happen under `mode = ANY`, but handled rather than assumed impossible).

There is deliberately no independent wall-clock timeout inside the loop itself — the bound on
"how long can this run" is the step budget above, plus each individual Playwright action's own
`timeoutMs` (default 5000ms on `click`/`type`/`select_option`), which surfaces as an ordinary
action failure (and therefore counts toward the dead-end limit) rather than a special
"timed out" status.

**Risky actions** are gated the same way during discovery as during replay (see
[`07-guardrails-and-safety.md`](07-guardrails-and-safety.md)): if
`GuardrailsPolicy.authorize()` classifies an action `risky`, the loop calls
`options.onRiskyAction` (wired to `EscalationController.confirmRiskyAction` in
`src/cli/run-agent.ts`, which is the terminal prompt shown in the walkthrough above); declining
ends the run with status `"escalated"`.

### Where

- `src/agent/discovery-agent.ts` — `DiscoveryAgent`, the loop itself.
- `src/agent/tool-schemas.ts` — `DISCOVERY_TOOLS`, `REASONING_FIELD`.
- `src/agent/observation-format.ts` — `formatObservation()` (turns a `StateSnapshot` into the
  text block Gemini reads) and `findElement()` (turns a model's `{role, name, nth}` back into
  a real `ObservedElement`).
- `src/agent/types.ts` — `DiscoveryStep`, `DiscoveryStatus`, `DiscoveryResult`.
- Wired in from `src/cli/run-agent.ts`, which supplies the real `PlaywrightSurface`,
  `GuardrailsPolicy`, `EvidenceLogger`, and `EscalationController` and, on a `"finished"`
  result, hands the transcript to `buildArtifact()` (see
  [`05-artifact-schema.md`](05-artifact-schema.md)).

### Worked technical example

Running the demo exactly as documented in `README.md`:

```bash
npm run mock-bank        # separate terminal
npm run run-agent
```

produces real terminal output of the shape:

```
Discovery run: discovery-2026-08-25T19-30-01-...
Goal: Sign on as operator "demo_operator" with password "demo_password", look up member 10001, ...

=== RISKY ACTION REQUIRES CONFIRMATION ===
POST /members/10001/sub-accounts is classified risky and requires confirmation.
Type 'yes' to proceed, anything else to decline:
yes

Discovery finished with status: finished
Evidence written to: evidence/runs/discovery-<timestamp>
Artifact written to: evidence/artifacts/open-sub-account.artifact.json
```

Every underlying decision that produced this is a JSONL line in
`evidence/runs/discovery-<timestamp>/log.jsonl`, each `"phase":"decide"` entry carrying the
tool name, its arguments, and the model's one-sentence `rationale` — the direct product of the
`reasoning`-field trick above.

### Edge cases & failure modes

- **A hallucinated element reference** (the model names a role/name/nth combination that
  doesn't exist in the current observation) is *not* silently retried — `resolveAction()`
  returns an `elementNotFoundError`, which is fed back to the model as a function error
  response and also counts toward `repeatedFailureCount`, exactly like a mechanical failure.
- **A guardrail block** (an action outside the allowlist, or one whose destination can't be
  predicted) ends the run immediately with status `"escalated"` — discovery never "tries
  around" a blocked action.
- **The model calls `select_option` on a field that's already at the requested value** — this
  is *expected and required*, not a bug (see "Rules" above); the recorder still records it as a
  parameterized step.
- **A sensitive value** (a `type` action targeting a field flagged `sensitive: true`, e.g. the
  password box) is registered with the evidence logger's redaction list (`logger.
  addSensitiveValue()`) the moment it's typed — before the raw text can ever reach a log line.
- **Escalation resume** re-injects context via a synthetic `functionResponse`, not by replaying
  history — the model re-observes the *current* real page state on the very next turn, so it
  can't act on stale information about what the screen looked like before the human intervened.

## Related docs

- [`03-surface-abstraction.md`](03-surface-abstraction.md) — what `observe()`/`perform()` actually return
- [`05-artifact-schema.md`](05-artifact-schema.md) — what a finished discovery run becomes
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — how risky-action confirmation and the allowlist work
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — what happens after `escalate`
- [`README.md`](../README.md) — "Demo path" step 2, the real command and output this walkthrough is drawn from
- [`REPORT.md`](../REPORT.md) — "1. Architecture," "Getting the 'why,' not just the 'what,' into the logs"
