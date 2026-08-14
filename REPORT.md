# Design Report

## 1. Architecture

Single Node/TypeScript process, no queues or services — deliberately, per the brief's
"don't build scaling infrastructure you don't need." The system is a small set of modules
with one clear responsibility each, wired together by two CLI entry points:

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
  on the artifact, not embedded in each step's URL, so the same artifact can point at a
  different tenant's instance.

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
replayed → step retried → run completes successfully. Everywhere business_outcome/
recoverable detection applies (both mid-action-failure and checkpoint-failure), not just one
of the two — an earlier version of this only handled it on the action-failure path, silently
never recovering from a checkpoint-shaped failure.

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
guess. Anything outside the allowlist is blocked outright, not just flagged.

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
field flagged sensitive. Nothing in `/evidence` contains the raw credential.

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

**What I'd build next**, roughly in order: (1) mid-artifact resume-after-failure, since
escalation without it is only half the story; (2) the UI-drift diff/report job, since the
data for it already exists (and would pair naturally with the confidence score — a step
that keeps falling back to a lower-confidence locator strategy should pull an artifact's
score down even if it's still technically succeeding); (3) reviewer identity on approval.

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
approved artifact stays approved until someone runs `--revoke` by hand.
