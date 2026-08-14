# Design Report

## 1. Architecture

Single Node/TypeScript process, no queues or services — deliberately, per the brief's
"don't build scaling infrastructure you don't need." The system is a small set of modules
with one clear responsibility each, wired together by three CLI entry points
(`run-agent`, `replay`, `approve`):

- **`Surface`** (`src/surface`) is the seam between "how we perceive/act on a UI" and
  everything above it. `observe()` returns a flattened, role-based view of the page
  (interactive controls + leaf text), built by walking the live DOM rather than trusting
  CSS classes or test IDs — the accessibility-tree stand-in that still works on legacy
  markup. Each observed element carries its own ordered locator fallback chain. `perform()`
  executes an action by trying that chain in order. `predictNavigation()` lets guardrails
  ask "where would this go?" without actually clicking. One Playwright implementation
  exists; the interface doesn't assume one.
- **`agent`** is the discovery loop: observe → Gemini function-call decision (one call per
  turn, `functionCallingConfig.mode = ANY`) → guardrail check → act → log → repeat, until
  the model calls `finish`, `escalate`, hits a repeated-failure dead-end, or times out.
- **`artifact`** defines the capability schema (Zod) and a recorder that turns a *finished*
  discovery transcript into one.
- **`replay`** executes a saved artifact with zero model calls: resolve locator → act →
  check → classify any deviation via the artifact's own `knownOutcomes`.
- **`guardrails`** is a single allowlist/risk policy consulted by *both* discovery and
  replay before every action, plus a redaction utility used by the logger.
- **`escalation`** is the pause/human-takeover/resume controller, shared by both paths.
- **`evidence`** is one structured JSONL logger + screenshot capture, used by everyone else.

Key trade-off: I chose to make locator resolution and the risk/allowlist check the *same
code path* for discovery and replay (both go through `Surface.perform`/`predictNavigation`
and `GuardrailsPolicy.authorize`). This costs a little indirection but means the replay
engine can't silently diverge from what discovery actually exercised — the artifact is a
faithful contract, not a second implementation of "how to click things."

**Getting the "why," not just the "what," into the logs.** Forcing exactly one function
call per turn (`functionCallingConfig.mode = ANY`, needed so the loop always gets a single
unambiguous action) means Gemini never emits an accompanying free-text explanation — a
first pass at this left every `"phase":"decide"` log entry with the tool and its arguments
but no rationale, quietly falling short of "a structured log of what the agent did and
why." The fix: every action tool's own argument schema requires a `reasoning` field, listed
first, so the model has to justify itself as part of the structured call, not beside it.
`/evidence` reflects this — each decision now carries a real one-line rationale.

**Verification.** Near-pure logic — checkpoint evaluation, redaction, allowlist route
matching (including origin-parsing edge cases), the confidence/registry math, the recorder's
artifact-building, schema cross-field validation, and the replay engine's recovery/retry
state machine — has a real unit test suite (`npm test`, Vitest, 81 tests) built against
small fakes (a stub `Surface`, a synthetic `DiscoveryResult`, a real `GuardrailsPolicy`
against a temp config where the class's private state made a plain fake impractical), not
mocks of the browser or the model. Deliberately *not* unit-tested with mocks: the Playwright
surface and the LLM loop itself. Mocking a browser or an LLM response would test the mock,
not the system; those are verified by the real discovery/replay runs in `/evidence` instead,
which the brief treats as the stronger signal anyway ("we can't assess a description of it").

**This system was adversarially reviewed after the first pass, and several real bugs were
found and fixed** — a route-allowlist bypass via string-prefix matching, recovery actions
bypassing the guardrail layer entirely, a replay retry that skipped re-verifying its own
checkpoint, an artifact confidence-fingerprint that wasn't actually stable, and the human-
escalation path having zero real evidence despite being cited as `/evidence`-verified. All
are described where they're structurally relevant below, and summarized together in Cuts,
because I think how they were found matters as much as the fixes themselves.

## 2. Artifact schema

The schema (`src/artifact/schema.ts`) is built around one idea: a capability is a
**contract**, not a step list. Design choices, and why:

- **Locators are an ordered fallback chain with recorded confidence + rationale**
  (`test_id` → `role`+`name` → `text` → `css_structural`), not a single selector. On a
  legacy app the first strategy that resolves *this month* may not be the one that
  resolves *next month*; replay tries each in order and logs which one matched — that log
  is the UI-drift signal (see §3, §4). A human reviewer can read `rationale` and judge
  whether a step is robust without running it.
- **`inputParams` / `outputSchema` are typed and separate from the steps.** A calling
  agent needs a stable contract ("give me `memberId`, `accountType`, `initialDeposit`; get
  nothing back") independent of how many steps it takes internally. Params carry a
  `sensitive` flag so redaction and future access-control decisions don't have to re-derive
  which fields are secret.
- **`knownOutcomes` are first-class, not exceptions bolted on afterward.** Each has a
  `category` (`business_outcome` / `recoverable` / `hard_failure`), a `detector`
  (reuses the same `Checkpoint` shape as steps — see §3), and, for recoverable outcomes, a
  `recoveryStepIds` list. Declaring "no such member" as a schema-level possibility, not a
  thrown error, is the single most important shape decision here — it's literally what the
  brief calls out as the most common design mistake.
- **`checkpoint` is optional per step, required once at the artifact level
  (`successCheckpoint`).** Not every step needs a post-condition (typing into a field
  doesn't), but reaching the goal does, and so do the milestones in between (post-login,
  post-search, post-form-load, post-submit) — enough to localize a failure to a specific
  step rather than "somewhere in this 9-step flow."
- **Steps reference params by `{paramRef}`, never bake in literal values** (except where
  a literal genuinely wasn't parameterized — see Cuts). `target.baseUrlPattern` is a field
  on the artifact, and `navigate` steps store paths *relative* to it (`/login`, not
  `http://localhost:4000/login`) — this was a real gap the first recorder implementation
  had (it captured the absolute URL straight off the page), which would have made
  `baseUrlPattern` a documented field with no actual effect. Fixed so the field is
  load-bearing: swap it and every navigate step re-targets.
- **Cross-field integrity is enforced by the schema itself, not left to convention.**
  `CapabilityArtifactSchema` (`src/artifact/schema.ts`) adds a `superRefine` pass on top of
  the base shape checking that every step's `paramRef` names a declared input param, every
  `outputSchema[].sourceStepId` names a real step, and every `recoveryStepIds` entry
  (used only when a known outcome's `category` is `recoverable`) names a real step. A
  hand-written or LLM-mutated artifact with a dangling reference fails to parse instead of
  failing at replay time three steps in — the recorder calls this same schema on its own
  output before returning it, so a broken artifact can't be produced by this system's own
  tooling either.

## 3. Determinism & error handling

**Determinism.** Replay never calls a model. Every action comes from the artifact's
`steps[]`, resolved through the same ordered locator chain discovery recorded. `waitPolicy`
gives each step a timeout and a small retry count for transient flakiness (a page that's
slow to settle, not a business condition). Playwright's `networkidle` wait after clicks
absorbs the artifact's built-in simulated slow-load scenario transparently, with no special
casing.

**The three-way split** (`ReplayResult` in `src/replay/types.ts`) is the core of this
section:

- `success` — outputs collected from `extract` steps, `successCheckpoint` passed.
- `business_outcome` — a step's action succeeded mechanically but a checkpoint didn't hold,
  *and* the current page matches a known outcome's detector (`member_not_found`,
  `permission_denied`, `validation_error` in this artifact). This is the caller's answer,
  not a crash — the replay CLI exits 0 for it, same as success.
- `failure` — nothing in `knownOutcomes` explains the deviation. Reported with the step id,
  what was expected, what was actually observed, and a screenshot path, specifically so a
  human can debug it without re-running.

**Recoverable conditions** get one real level of self-healing: `session_timeout`'s detector
matches a redirect-to-login banner; its `recovery: "reauthenticate_and_retry_step"` re-runs
a declared list of prior steps (re-login, *and* re-entering the search field the redirect
wiped out — recovery has to reconstruct whatever in-page state was lost, not just retry the
one failing action) and then retries the step that originally failed. This is exercised for
real in `/evidence` (member `90909`): checkpoint fails → outcome detected → recovery steps
replayed → step retried → run completes successfully. This runs through one unified
`executeStep` path regardless of *why* the step needed recovery (mechanical action failure,
or a checkpoint that didn't hold after an apparently-successful action) — an earlier version
had two separate code paths for those two triggers and only one of them re-ran the
guardrail check and re-verified the checkpoint/extract afterward; the other did a bare
retry that could silently skip verification. Recovery is capped at one attempt per step, so
a misbehaving detector can't loop forever.

**Every guardrail check happens through one function, `authorizeAndConfirm`**, called
before the *original* attempt at a step, before *every* recovery step, and before a
post-recovery retry of the step that failed. This closes a real gap: the first
implementation had recovery and retries call the surface directly, bypassing
`GuardrailsPolicy.authorize()` entirely — meaning a risky POST could effectively re-fire
unattended during "recovery" with no re-confirmation, even in a run that required
interactive confirmation for its first attempt. There's also a second, independent check
after a `navigate`/`click` actually executes: the *landed* URL is re-checked against the
allowlist (`authorizeLandedUrl`), because a redirect chain — or, on this app, a validation
error re-rendering the same page in place as the direct response to a POST rather than
redirecting — can land the browser somewhere the pre-flight prediction never saw.

**Secondarily, UI drift**: every action result records which locator strategy actually
matched. A production version would diff that against what was recorded and flag "step-6
resolved via `css_structural` instead of `role`" as a drift signal for review — the schema
already carries what's needed; only the diffing/reporting layer is unbuilt (see Cuts).

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is exactly `Surface.observe()`/`perform()`/
`predictNavigation()`. A legacy web app (frames, nested tables, no semantic markup) is
already what the mock app *is* — the DOM-walking observer doesn't depend on clean markup,
only on standard interactive tags and computed accessible names, which is why it survives
`<font>`/`<table>`-based layouts unmodified. A desktop surface would be a second
implementation of the same three methods backed by OS accessibility APIs (UIA on Windows,
AXUIElement on macOS) instead of Playwright; `LocatorStrategy` already has room for a
`desktop_automation_id` variant alongside `role`/`text`/`css_structural`. Nothing above
`Surface` — agent, artifact, replay, guardrails — would need to change.

**Multi-tenant reuse.** Artifacts are already tenant-agnostic in the ways that matter:
`target.baseUrlPattern` is a field, not embedded per-step, and URL checkpoints are path
*templates* (`/members/{memberId}`, not `/members/10001`). The natural extension (not
built, since Section 3.7 says design-not-build) is an **override layer** keyed by
`(vendorProductId, tenantId)` that can patch specific `locatorCandidates` or copy strings
without forking the whole artifact — the same idea as a CSS theme override, applied to the
base artifact at load time before replay. Two tenants running the same vendor product would
share one base artifact; a tenant with a rebranded button label gets a one-line override to
its `text` locator candidate, not a re-recording.

**Drift detection at scale** falls out of the same mechanism described in §3: replay already
logs which locator strategy matched per step. A fleet-level job could aggregate "artifact X,
tenant Y, step 6: css_structural instead of role, 3 days running" into a review queue,
without any replay-time behavior change.

## 5. Escalation & handoff

**Detecting stuck.** Three independent triggers, all real: (1) the discovery model calling
its `escalate` function when it judges an error/ambiguous state/repeated failure isn't
resolvable from the goal alone; (2) a guardrail-classified `risky` step, in *either*
discovery or replay, requiring explicit confirmation before it executes; (3) a replay
`failure` result (no known outcome explains the deviation).

**Taking control of the live session.** The browser runs headed specifically so this is
real, not simulated: "ceding control" means the automation driver simply stops issuing
Playwright commands against the exact same `Page`/browser context a human can see and use.
`EscalationController` (`src/escalation/controller.ts`) tracks a `controller: 'automation' |
'human'` flag, writes a structured `intervention_request` (goal/capability, step, reason,
screenshot, URL) to evidence, and blocks on a CLI prompt. While the human has control, a
`framenavigated` listener captures where they navigate as evidence. On resume, the discovery
loop **re-observes** rather than assuming it knows where the human left the page — this is
what makes "same session, not a fresh one" actually true rather than aspirational.

**Handing back control.** For discovery, `resume` re-enters the observe→decide→act loop
with a function-response telling the model a human just acted, so it re-orients from the
current state. For replay, the risky-step confirmation gate is the same mechanism; a
production build would extend it to resume mid-artifact after a hard failure, which today
just returns the `failure` result for the caller to handle (see Cuts).

**What's mocked deliberately:** the operator "console" is a terminal prompt, per the
brief's explicit scope note. What's *not* mocked: the actual control-transfer model (who's
driving, on which session, with what evidence trail) is real and exercised in `/evidence`.
A real console would swap the CLI prompt for a web UI that attaches to the same Playwright
`Page` (e.g. via its CDP endpoint) — the same `controller` flag and intervention-request
shape would carry over unchanged.

## 6. Safety

**Allowlist** (`config/allowlist.json`) is route-pattern + HTTP-method based, not
action-type based: each rule says which `(pattern, method)` pairs are permitted and whether
they're `safe` or `risky`. Every action — discovery or replay — is checked via
`GuardrailsPolicy.authorize()` before it executes; for a `click`/`navigate`,
`Surface.predictNavigation()` resolves the *actual* pending destination (a form's real
`method`/`action`, or a link's `href`) so the check reflects what will really happen, not a
guess. Base-URL comparison is origin-based (`new URL(...).origin`), not a string-prefix
check — the earlier `startsWith` version would have let `http://localhost:4000.evil.example.com`
or `http://localhost:4000@evil.com` (userinfo-in-URL) both pass as "allowed," since both
literally start with the configured base string. Anything outside the allowlist is blocked
outright, not just flagged, with one deliberate exception: `predictNavigation` returns three
distinct things — a real destination (checked normally), `null` for "this element exists but
its destination can't be determined" (fails *closed*, since that's exactly the JS-driven-write
case the allowlist exists to catch), and `undefined` for "this element doesn't even resolve on
the current page" (treated as safe to let `perform()` fail on its own). Collapsing that last
case into "block" was an early bug: on the permission-denied page the "Open Sub-Account" link
legitimately isn't rendered at all, and the guardrail layer was misreporting a business
outcome as a security block.

**Risky vs. safe.** Writes (here: the one POST route, opening a sub-account) are `risky`;
everything else in this flow is a GET and `safe`. The conservative default: risky actions
always require confirmation — interactively in discovery, and in replay either an
interactive confirmation or an explicit `--allow-risky` flag standing in for "this artifact
was reviewed and approved for unattended production execution." That flag is no longer a
bare trust-me switch: it's gated by the confidence/approval registry (§8) — a freshly
recorded artifact is `draft`, where `--allow-risky` is silently ignored and risky steps
always block on interactive confirmation, regardless of the flag. Only an explicitly
`approve`d artifact honors it. I think this is the right conservative choice for a system
whose write actions touch real account state at a bank.

**Redaction.** The logger masks two things: fields whose *name* looks sensitive (password,
token, SSN...) via pattern match, and any occurrence of a *registered secret value*
(`EvidenceLogger.addSensitiveValue`) wherever it appears, regardless of field name. That
second mechanism exists because of a real bug I found and fixed while producing evidence:
the demo goal string embeds credentials in plain English for the model to type
("...password 'demo_password'..."), and the very first log line (the run's own goal) would
otherwise have logged it in the clear, before the discovery loop had ever "seen" the
password field to know it was sensitive. The fix registers known-sensitive values (the CLI's
`--password`) before any logging happens, not just when the agent happens to type into a
field flagged sensitive. The name-based check also used to only apply inside the
string-value branch of the redactor, so a sensitive key holding a number, boolean, or nested
object passed through unmasked — moved to run first, before any type branching, so it's
uniform. Value-based scrubbing has a minimum-length floor (6 characters) so it doesn't start
masking short, coincidentally-matching substrings inside unrelated fields. Nothing in
`/evidence` contains the raw credential (verified by grepping the committed evidence tree
for the plaintext password).

**Limits.** The allowlist is static per run, not per-tenant/per-role; there's no
audit trail beyond the JSONL log; and the risky/safe classification is manual (route rules
in a config file), not inferred from anything about the data being touched.

## 7. Cuts

- **One stretch goal implemented** (Confidence & approval, §8); the rest were deliberately
  skipped per Section 8's "pick at most one or two, depth over breadth" — time went into
  getting the core loop, artifact schema, determinism, and escalation genuinely right
  (including finding and fixing the real bugs described above) rather than adding a
  capability catalog, code generation, assisted fallback, or cross-tenant canonicalization.
- **`known_outcomes` are human-authored, not auto-mined.** A single happy-path discovery
  run never observes its own error states by definition. A production version would run
  discovery against seeded error fixtures too, or gate known-outcome additions behind
  reviewer approval; here they're supplied as a small domain config
  (`src/cli/capabilities/open-sub-account.ts`) alongside the recorder, the same way a human
  reviewer would annotate a capability before approving it.
- **No literal-to-parameter generalization pass.** The recorder maps observed
  `(role, name)` pairs to named params via a small explicit table, not an LLM
  generalization step. Simpler and fully deterministic, at the cost of needing that table
  hand-maintained per capability.
- **No UI-drift diffing job**, despite the data (matched-locator-strategy per step) already
  being logged — described in §3/§4 but not built.
- **No mid-artifact resume after a replay hard failure.** A failure returns to the caller
  today; a fuller build would let a human fix the live state during escalation and resume
  replay from the next step, mirroring what discovery's `resume` already does.
- **Desktop/legacy-web/multi-tenant are design-only**, per the brief's explicit "not
  necessarily build" — addressed in §4, not implemented.
- **The approval registry has no per-user identity** — `approve` records *that* an artifact
  was approved, not *by whom*. A real deployment would tie this to an authenticated
  reviewer, not a CLI command anyone with repo access can run.

**What survived an adversarial pass, and what's honestly still left after it.** I ran a
deliberately hostile review of this system after the first pass (looking for exactly the
kind of gap a grader would look for — guardrail bypasses, false claims in this document
versus what `/evidence` actually contains, silent correctness bugs) and fixed everything it
found that was fixable in scope: the allowlist bypass, recovery skipping guardrails, the
unstable fingerprint, the missing escalation evidence, and about a dozen more (folded into
the relevant sections above rather than listed separately here). What's still genuinely
open, not because it wasn't found but because fixing it properly is bigger than this
exercise:
  - The confidence score's honesty is bounded by the correctness of `knownOutcomes`
    detectors (see §8) — a systematically wrong detector still accumulates "trustworthy"
    history. The `medium ⇒ totalRuns ≥ 2` rule is a floor, not a fix.
  - `registry.json` is read-modify-written with no file locking; two replays finishing at
    the same instant could race and one's history entry could be lost. Fine for a CLI tool
    run by one operator at a time, not fine as a shared service.
  - The discovery loop's conversation history grows unbounded for the lifetime of a run —
    no windowing or summarization. Not a problem at the step counts this system exercises;
    would matter for a much longer-running goal.
  - `page.evaluate`'s DOM-scan function has to work around a `__name` helper that esbuild/tsx
    injects into transpiled named functions, by wrapping the evaluated function in a small
    IIFE shim. It works, but it's a coupling to a build-tool implementation detail rather
    than anything Playwright or the DOM guarantees — the kind of thing that quietly breaks
    on a toolchain upgrade.

**What I'd build next**, roughly in order: (1) mid-artifact resume-after-failure, since
escalation without it is only half the story; (2) the UI-drift diff/report job, since the
data for it already exists (and would pair naturally with the confidence score — a step
that keeps falling back to a lower-confidence locator strategy should pull an artifact's
score down even if it's still technically succeeding); (3) reviewer identity on approval;
(4) some outside-the-system check on `knownOutcomes` detector correctness, since that's the
one gap above that quietly undermines a feature (confidence scoring) that already shipped.

## 8. Stretch goal: Confidence & approval

**What it does.** `src/artifact/registry.ts` scores each *exact recorded version* of an
artifact by its replay history and gates unattended replay behind an explicit
`draft → approved` transition:

- Every replay outcome (`success` / `business_outcome` / `failure`) is appended to
  `evidence/artifacts/registry.json`, keyed by a content fingerprint (a hash of the
  artifact's steps, params, outputs, and checkpoints — not just `id`+`version`, and not
  cosmetic fields like `createdAt`). A materially different re-recording starts back at
  `draft`/`unproven` automatically; it hasn't earned whatever trust the old content had.
- Confidence is `(success + business_outcome) / total` — both mean *the artifact correctly
  did its job*, including correctly reporting a legitimate business outcome; only a
  `failure` (the replay engine couldn't explain what happened) counts against it. This
  reuses the same three-way result split from §3 rather than inventing a second notion of
  "worked."
- A fresh artifact is `draft`. In `draft`, `--allow-risky` is silently ignored — risky
  steps always block on interactive confirmation, no matter what flag was passed. Only
  `npm run approve -- --artifact <path>` (which prints the current confidence first, so the
  approval is an informed one) flips it to `approved`, after which `--allow-risky` is
  honored for unattended replay of that exact content.

**Why this shape.** The brief asks for confidence scoring *and* an approval gate — treating
them as two separate features risks the gate being decorative (an artifact could be
`approved` with zero evidence it ever worked). Tying them together so the approval command
itself surfaces the confidence score, and gating the practical effect of approval
(`--allow-risky`) on the state, makes the score load-bearing rather than informational.

**Real evidence in `/evidence`:** a sequence of replay runs against a freshly recorded
`draft` artifact (confidence climbing `unproven → medium → high` as clean runs accumulate,
including a business outcome counted correctly as clean), one showing `--allow-risky`
explicitly ignored and falling back to a confirmation prompt, an `approve` run showing the
confidence summary at the moment of approval, and a final replay with `--allow-risky` that
completes with zero stdin interaction (`< /dev/null`) now that the artifact is approved.

**Cut from this stretch goal:** no reviewer identity (see §7), no automatic *demotion* back
to draft if confidence later drops (e.g. from accumulating failures post-approval) — an
approved artifact stays approved until someone runs `--revoke` by hand. Also worth being
direct about: the confidence score trusts the replay engine's own business_outcome/failure
classification. If a `knownOutcomes` detector were wrong — too loose, matching pages it
shouldn't — every run would score as a clean business outcome and confidence would climb
regardless of whether the artifact actually still works. The one mitigation in place is
structural, not semantic: `medium` requires at least two recorded runs, not just a score
threshold, so a single lucky/misclassified run can't alone produce a "trustworthy-looking"
label. That doesn't touch the underlying risk — a *systematically* wrong detector, replayed
many times, still gets rewarded. Catching that needs either detector review as part of
`approve`, or comparing detector outcomes against something outside the system's own
say-so (e.g. periodic human spot-checks of `business_outcome` runs) — neither is built.
