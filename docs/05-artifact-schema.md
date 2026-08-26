# The Capability Artifact Schema

## In one sentence

A capability artifact is a typed, versioned **contract** — ordered steps with their own
locator fallback chains, typed inputs and outputs, checkpoints, and a first-class list of
"things that can normally happen" — not a loose transcript of what the AI happened to click,
and the schema itself refuses to represent a version of that contract that's internally broken.

---

## Part 1 — For everyone: a recipe card, not a video recording

### The analogy

Imagine the difference between (a) a video recording of a chef making a dish, and (b) a
proper recipe card. The video shows *what happened once*; the recipe card is written so a
*different* person, on a *different* day, with a *different* quantity of an ingredient, can
still produce the right dish — and it also tells you what a normal, expected variation looks
like (e.g. "if the dough looks too dry, that's fine, just add a tablespoon of water" is
different from "if the oven catches fire, that's not normal, stop and get help").

A capability artifact is the recipe card, not the video. It's what gets written after the
discovery agent (see [`04-discovery-agent.md`](04-discovery-agent.md)) successfully finishes a
task once — the finished transcript is fed into `buildArtifact()` and turned into this typed
structure, saved as JSON in `evidence/artifacts/`.

### A real step, explained like a recipe card

Here is a genuinely simplified version of real step 2 from the real artifact this project's
demo produces, `evidence/artifacts/open-sub-account.artifact.json`:

```json
{
  "id": "step-2",
  "actionType": "type",
  "description": "Type into textbox \"Operator ID\"",
  "locator": [
    { "strategy": "role", "role": "textbox", "name": "Operator ID", "confidence": "high" },
    { "strategy": "text", "name": "Operator ID", "confidence": "medium" },
    { "strategy": "css_structural", "cssPath": "#username", "confidence": "low" }
  ],
  "input": { "paramRef": "username" },
  "risk": "safe"
}
```

Reading it the way you'd read a recipe card:

- `"id": "step-2"` — this is step 2 of the recipe, just a name so other parts of the recipe
  (like "if this goes wrong, redo steps 2 through 5") can refer back to it.
- `"actionType": "type"` — the instruction is "type something."
- `"description"` — a plain-English caption for a human reviewer, purely for reading, never
  actually executed by the computer.
- `"locator"` — *how to find the box to type into*, written as a priority-ordered list of
  three different ways to recognize it: first try "the textbox whose accessible name is
  Operator ID," and if that somehow stops working, fall back to "the text on the page that
  exactly says Operator ID," and if even that fails, fall back to "whatever's at this exact
  spot in the page's structure" — a last resort, since that's the one most likely to break if
  the page is redesigned even slightly.
- `"input": { "paramRef": "username" }` — this is the important part: it does **not** say
  "type `demo_operator`." It says "type whatever value the caller supplies for the ingredient
  named `username`." That's the difference between a recipe that only ever makes one specific
  cake and a recipe that makes a cake for *whichever* birthday name you give it.
- `"risk": "safe"` — typing into a text box can't cause any real damage on its own, so it never
  needs a human's confirmation before happening (compare this to the real `"risk": "risky"` on
  step-10, the final Submit click, which actually opens the account).

### "What happens if...?" — real scenarios

| Situation | What happens |
|---|---|
| A caller wants to replay this artifact against member `10002` instead of `10001` | Nothing about the artifact changes — `memberId` is a declared input param; only the *value* supplied at replay time changes. |
| Member `40404` doesn't exist | The artifact already knows about this — it's a declared `knownOutcome` named `member_not_found`, category `business_outcome` — so replay reports it as a clean, useful answer, not an error. |
| The operator's session times out mid-flow (a real, seeded scenario for member `90909`) | Also a declared `knownOutcome`, category `recoverable`, with a `recovery` of `reauthenticate_and_retry_step` and the exact list of steps to redo first (re-login, then re-enter the search field the redirect wiped out). |
| Someone hand-edits the artifact's JSON and typos a step ID in a "redo these steps" list | The artifact **fails to even parse** — it's rejected before it can be recorded or replayed, not discovered as a mystery bug three steps into a live replay. |
| The same account-opening capability is pointed at a different credit union's server | Only `target.baseUrlPattern` needs to change — every step's URL is stored *relative* to it, so the whole artifact re-targets from one field. |
| A step's value is genuinely always the same literal (never something a caller should supply) | It's stored as `{ "literal": "..." }` rather than a fake `paramRef` invented just to have one — see "Cuts" in `REPORT.md` for the one real place this shows up. |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief's own framing is that a recorded run has to become "a reusable capability... a
typed, versioned artifact — not a raw transcript of a browser session." A raw transcript would
tightly couple the artifact to the exact literal values used during the one discovery run that
produced it (`memberId=10001`, `$100`), give a calling agent nothing to validate its inputs
against, and have no principled way to tell "no such member" apart from "this genuinely broke."
The schema (`src/artifact/schema.ts`, built on Zod) exists to make all three of those things
impossible to get wrong by construction.

### What

`CapabilityArtifactSchema` describes an object with:

- `id`, `name`, `description`, `version`, `createdAt`, and `target` (`appId`, `surfaceType:
  "web"`, `baseUrlPattern`).
- `inputParams: InputParam[]` — `{ name, type, required, sensitive, description }`. `sensitive`
  is a first-class flag (e.g. `password`), not something redaction has to re-derive later.
- `outputSchema: OutputField[]` — `{ name, type, sourceStepId, description }`, typed and
  declared independently of how many internal steps it took to produce them.
- `steps: ArtifactStep[]` — the ordered recipe (see "How" below).
- `successCheckpoint: Checkpoint` — required once, at the artifact level: the one condition
  that means "the whole goal was actually reached."
- `knownOutcomes: KnownOutcome[]` — the declared, first-class list of "things that can
  normally happen."

### How

**Locators are a fallback chain with recorded confidence and rationale, not a single
selector**, reusing the exact `LocatorCandidateSchema` shape from `src/surface/types.ts`
(`test_id` → `role` → `text` → `css_structural`, each with `confidence: "high"|"medium"|"low"`
and a human-readable `rationale`). This is the same chain `Surface` computed during discovery
(see [`03-surface-abstraction.md`](03-surface-abstraction.md)) — the artifact doesn't invent
its own, independent notion of "how to find this element."

**Steps reference params, never literal values, via `StepInputSchema`:**
```ts
export const StepInputSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ paramRef: z.string() }),
]);
```
`buildArtifact()` (`src/artifact/recorder.ts`) decides which of the two applies per step by
consulting a `ParamMapping` table (`{ role, name, paramName, type, sensitive?, description? }`)
supplied by the caller (`OPEN_SUB_ACCOUNT_PARAM_MAPPINGS` in
`src/cli/capabilities/open-sub-account.ts` for this demo capability). This is a deliberate,
human-authored table, not an LLM-generalization pass — for a schema this small, an explicit
mapping is simpler, fully deterministic, and exactly as reviewable as an inferred one would be,
per the trade-off recorded in `REPORT.md` "Cuts." A `type`/`select_option` step whose target
element has no mapping entry falls back to `{ literal: <the value actually typed during
discovery> }` — which is why `step-11`'s locator (extracting the confirmation number) can
legitimately never re-match on a later run: its `text` candidate was recorded as the literal
`"SA-00001"`, a value that's true only once. That's a known, documented false-positive category
for drift detection (see [`12-ui-drift-detection.md`](12-ui-drift-detection.md)), not a schema
bug.

**`navigate` steps store relative paths, never absolute URLs.** `toRelativePath()` in
`recorder.ts` strips `options.baseUrlPattern` off the discovered URL before it's written into
`step.url`. This was a real gap in an earlier version — the first recorder implementation
captured the raw absolute URL straight off the page, which would have made
`target.baseUrlPattern` a documented field with no actual effect on replay. Fixed so the field
is load-bearing: change `baseUrlPattern` for a different tenant/environment, and every
`navigate` step re-targets with it, with no per-step editing required.

**Checkpoints are optional per step, required once at the artifact level.**
`CheckpointSchema` (`{ kind: "url"|"element_visible"|"text_match", expr, description }`) is
reused in three places: a step's own `checkpoint`, the artifact's `successCheckpoint`, and
every `KnownOutcome`'s `detector` — one shape, three roles. A step like "type into a text box"
doesn't need one; a milestone like "did signing on actually land on `/search`?" does — enough
checkpoints to localize a failure to a specific step, not just "something in this nine-step
flow went wrong."

**`knownOutcomes` are schema citizens, not exceptions bolted on after the fact.** Each
`KnownOutcome` has a `category` — `business_outcome` (a legitimate answer, e.g.
`member_not_found`, `permission_denied`, `validation_error` in this artifact), `recoverable`
(e.g. `session_timeout`, with `recovery: "reauthenticate_and_retry_step"` and an explicit
`recoveryStepIds` list of which prior steps to redo), or `hard_failure`. This single design
choice is, per `REPORT.md`, "literally what the brief calls out as the most common design
mistake" to get wrong — treating a business answer like a crash. `knownOutcomes` are
*authored from domain knowledge of the target app*, not mined automatically from the
happy-path discovery trace — `RecorderOptions.knownOutcomes` is supplied by the CLI the same
way a human reviewer would annotate a capability before approving it for unattended use.

**Cross-field integrity is enforced by the schema itself, via `superRefine`.** A plain
Zod object shape can check each field's own type, but can't check relationships *between*
fields — so `CapabilityArtifactSchema` adds a `superRefine` pass that walks the whole object
and rejects it if:
- any step's `input.paramRef` names a param not present in `inputParams`;
- any step sets `outputName` while not actually being an `"extract"` step;
- any `outputSchema[].sourceStepId` names a step that doesn't exist;
- any `knownOutcomes[].recovery`/`recoveryStepIds` is set on an outcome whose `category` isn't
  `"recoverable"`;
- any `recoveryStepIds` entry names a step that doesn't exist.

`buildArtifact()` calls `CapabilityArtifactSchema.parse(artifact)` on its own output before
ever returning it — so a broken artifact (a typo'd `paramRef`, a dangling `recoveryStepIds`
entry) can't be produced by this system's own tooling, let alone survive being hand-edited and
loaded later. Before this check existed, a typo'd `paramRef` would have silently resolved to
an empty string at replay time, three steps deep, instead of failing loudly at record time.

### Where

- `src/artifact/schema.ts` — every Zod schema described above; `CapabilityArtifact` is the
  inferred TypeScript type everything else in the system uses.
- `src/artifact/recorder.ts` — `buildArtifact()`, `ParamMapping`, `RecorderOptions`,
  `attachStepCheckpoint()` (post-processing helper that attaches a checkpoint to the first
  step matching a predicate, robust to discovery taking a slightly different number of steps
  to reach the same milestone).
- `src/cli/capabilities/open-sub-account.ts` — the real, checked-in `ParamMapping[]`,
  `knownOutcomes`, and `successCheckpoint` for this demo capability.
- `src/cli/run-agent.ts` — calls `buildArtifact()` after a `"finished"` discovery run and
  writes the result to `evidence/artifacts/open-sub-account.artifact.json`.
- Consumed by `src/replay/replay-engine.ts` (see
  [`06-deterministic-replay.md`](06-deterministic-replay.md)) and scored by
  `src/artifact/registry.ts` (see [`10-confidence-and-approval.md`](10-confidence-and-approval.md)).

### Worked technical example

The real artifact-level `successCheckpoint` and one real `knownOutcome` from
`evidence/artifacts/open-sub-account.artifact.json`:

```json
"successCheckpoint": {
  "kind": "text_match",
  "expr": "Sub-account opened successfully",
  "description": "The confirmation banner is visible."
},
"knownOutcomes": [
  {
    "name": "member_not_found",
    "category": "business_outcome",
    "detector": {
      "kind": "text_match",
      "expr": "No member found with ID",
      "description": "Search returned no matching member."
    },
    "description": "No member exists with the given memberId. A legitimate result, not a crash."
  }
]
```

Regenerating this artifact from scratch (`npm run run-agent`) and then attempting to validate
a deliberately broken copy — say, renaming `inputParams[2].name` from `memberId` to
`memberIdX` without updating step-5's `input.paramRef` — reproduces the schema's own rejection:

```
ZodError: Step "step-5" references undeclared input param "memberId".
```

### Edge cases & failure modes

- **A discovery run that didn't finish** (`status !== "finished"`) is rejected by
  `buildArtifact()` outright, with a thrown error — there is no code path that produces an
  artifact from an escalated, dead-ended, or max-stepped run.
- **A `type`/`select_option` step with no matching `ParamMapping`** falls back to a literal
  value captured at discovery time rather than being silently dropped or crashing the recorder.
- **A step's only locator candidate is a value that will never recur** (dynamic data extracted
  as `text`, like a freshly-issued confirmation number) — not a schema violation, but a known
  drift-detection false positive; documented rather than silently "fixed" by excluding it, since
  doing so correctly requires distinguishing static copy from dynamic data in general.
- **A hand-edited or LLM-mutated artifact with any dangling reference** — undeclared `paramRef`,
  non-existent `sourceStepId`, non-existent `recoveryStepIds` entry, or `recovery` fields set on
  a non-`recoverable` outcome — fails `CapabilityArtifactSchema.parse()` immediately, both when
  the recorder builds it and whenever it's loaded again later (e.g. by the replay engine).

## Related docs

- [`04-discovery-agent.md`](04-discovery-agent.md) — the finished transcript this schema is built from
- [`06-deterministic-replay.md`](06-deterministic-replay.md) — how steps, checkpoints, and knownOutcomes are actually executed
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — how each step's `risk` field gates confirmation
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — how replay history against this exact artifact content is scored
- [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) — why `baseUrlPattern` and relative step URLs matter for reuse
- [`REPORT.md`](../REPORT.md) — "2. Artifact schema" for the original design rationale
