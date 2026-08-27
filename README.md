# Computer-Use Automation System

[![CI](https://github.com/devpatel122003/computer-use-automation-system/actions/workflows/ci.yml/badge.svg)](https://github.com/devpatel122003/computer-use-automation-system/actions/workflows/ci.yml)

A small, real end-to-end slice of the system described in the take-home brief: an LLM
drives a live web app to accomplish a goal (**discovery**), the successful run is recorded
as a typed, versioned **capability artifact**, and that artifact **replays deterministically**
— no model involved — with structured success / business-outcome / failure results, an
allowlist-based guardrail layer, and a real (not mocked) human-escalation handoff. It also
includes five of the brief's six Section 8 stretch goals (see `REPORT.md` "Stretch goals" for
why this went past the original submission's "pick one or two"): **confidence scoring + a
draft→approved approval gate** on unattended replay (now also a real circuit breaker: an
approved artifact whose confidence UI-drift has degraded falls back to attended
confirmation, not just a badge); **cross-tenant reuse** — the same recorded artifact, applied
to a second, differently-branded tenant via a small named override, with a real cross-tenant
drift comparison in the dashboard; an **agent-facing capability interface** — an HTTP surface
an AI agent could discover and invoke by name with typed args, now paired with a small
conversational front end that maps natural language to that same call; **assisted
fallback** — one bounded, policy-checked LLM recovery per failed step, including a
vision-grounded fallback for surfaces with no DOM at all; and **multi-run stability** — a
real, unattended canary health check over the confidence registry's own recent-run history,
distinct from lifetime confidence, gated through the exact same guardrails/circuit breaker as
any other caller. A separate, non-stretch-goal addition turns the same evidence every run
already writes into a compliance/audit report for a bank's audit function specifically.

See [`REPORT.md`](REPORT.md) for the design write-up (architecture, artifact schema,
determinism & error handling, heterogeneity/multi-tenant story, escalation model, safety,
and cuts), and [`SECURITY.md`](SECURITY.md) for the consolidated threat model, auth, and
guardrail design in one place.

## What's in here

- `apps/mock-bank/` — the target application: a small, deliberately legacy-styled
  (server-rendered, table layout, no test IDs) banking back-office app supporting five real
  flows: member-search → member-detail, open-sub-account, create-member, check-balance
  (read-only), transfer-funds (between a member's own checking/savings), and
  close-sub-account -- plus seeded scenarios for not-found / permission-denied /
  validation-error / insufficient-funds / already-closed / session-timeout / slow-load.
  Real (if simple) persistence: every mutation is written to
  `apps/mock-bank/data/state.<tenantId>.json` immediately, and a restart resumes from that
  file instead of always reseeding -- a created member or sub-account survives a real
  process restart. `POST /__test__/reset` is the deliberate escape hatch back to seed data
  (also deletes-and-rewrites that file); delete `apps/mock-bank/data/` yourself for the same
  effect. Gitignored -- it's generated state, not source.
- `src/surface/` — the `Surface` abstraction (observe/act) and its Playwright implementation.
- `src/agent/` — the discovery loop: observe → Gemini function-call decision → act; also
  `model-retry.ts`, the shared 429/503 backoff-and-retry used by every real Gemini call in
  this repo (discovery, the conversational front end, and assisted recovery alike), plus
  `withModelFallback` -- the same modules falling back across `GEMINI_FALLBACK_MODELS` the
  moment a *daily* quota (not just a per-minute rate limit) is exhausted, see "Gemini quota
  fallback" below.
- `src/artifact/` — the capability artifact schema (Zod), the recorder that builds one from
  a finished discovery run, the confidence/approval registry (stretch goal), the
  tenant-override module for cross-tenant reuse (stretch goal), and `stability.ts`
  (`computeStabilitySignal`, the multi-run stability stretch goal — a recent-window
  flakiness/health signal, distinct from the registry's lifetime confidence score).
- `src/replay/` — the deterministic replay engine, the checkpoint/known-outcome evaluator,
  the UI-drift signal (`npm run drift-report` -- diffs each replay's matched locator
  strategy against what was recorded, per step), the confidence circuit breaker
  (`execution-policy.ts`), and the opt-in bounded LLM-assisted recovery
  (`assisted-recovery.ts`, `--assisted-recovery true` -- includes a vision-grounded
  fallback for surfaces with no DOM at all; replay never calls a model unless this is
  explicitly turned on).
- `src/dashboard/` — a small read-only ops page (`npm run dashboard`) that renders the
  artifact contract, approval/confidence state, drift signal, a discovery-vs-replay
  time/model-call comparison, per-tenant variant trust, and a cross-tenant drift comparison
  for every capability, in one place instead of many CLI invocations. Recomputes from disk
  on every request; makes no writes.
- `src/api/` — the agent-facing capability interface (stretch goal): `GET /capabilities`
  to discover, `POST /capabilities/:id/invoke` to invoke by name with typed args (and an
  optional `tenantId` to invoke a specific tenant's variant -- see `tenant-resolution.ts`,
  which ties this directly to the cross-tenant reuse stretch goal). A thin wrapper around
  the same `replay()`/`GuardrailsPolicy`/registry gate the CLI uses -- see
  `src/cli/agent-invoke-demo.ts` for a script that calls it the way an agent would.
- `src/frontend/` + `src/cli/agent-chat.ts` — the other half of "the agent-facing product
  decides what to do; this system is how it reliably and safely does it": a natural-language
  request mapped by one Gemini function-call decision to a capability + typed args, then
  invoked through the exact same capability API above. `chat-turn.ts` is the one shared
  discover→plan→invoke implementation both the CLI and `src/chat-ui/` (a real web page,
  step 11b) call into.
- `src/chat-ui/` — a real member-facing chat (+ voice, client-side via the browser's Web
  Speech API) UI on top of `chat-turn.ts`, holding its own service-account operator
  credential server-side so a customer's chat text is never what actually authenticates.
- `src/guardrails/` — the allowlist policy, risk classification, and redaction utilities.
- `src/escalation/` — the intervention/handoff controller (pause automation, let a human
  drive the same live browser session, capture what they did, hand control back); shared by
  both discovery and, as of this pass, replay's own `--interactive-escalation` (see
  `src/replay/replay-engine.ts`'s `onEscalate` and README step 4c below).
- `src/http/` — production-hardening middleware shared by the capability API and dashboard:
  `api-key-auth.ts` (bearer/API-key auth for the capability API, HTTP Basic auth for the
  dashboard, both timing-safe and fail-closed at startup if unconfigured — see `SECURITY.md`)
  and `request-log.ts` (one structured JSON access-log line per request, shape-only, never
  headers or bodies).
- `src/evidence/` — the structured JSONL run logger, plus `audit-report.ts` (not a Section 8
  stretch goal — a non-numbered addition that reformats the same redacted evidence every run
  already writes into a compliance/audit report for a bank's audit function).
- `src/cli/` — the entry points (`run-agent`, `run-agent-create-member`,
  `run-agent-check-balance`, `run-agent-transfer-funds`, `run-agent-close-sub-account`,
  `replay`, `approve`, `escalation-resume-demo`, `escalation-resume-replay-demo`,
  `compliance-report`, `canary-check`) and every capability's domain config (param mappings,
  checkpoints, known outcomes) — `open-sub-account` (act on an existing member),
  `create-member` (enroll a brand new one), `check-balance` (a read-only lookup, no new
  mock-bank route needed at all), `transfer-funds` (move money between a member's own
  checking/savings), and `close-sub-account` (close an existing one). Five independently
  recorded artifacts proving the system generalizes past the first capability, each from its
  own genuine discovery run against a real, working mock-bank feature.
- `apps/mock-bank/src/tenants.ts` + `config/tenant-overrides/` — a second tenant ("Northgate
  Credit Union") served from the *same* mock-bank app/routes/views with different copy and
  DOM structure, and the override file that adapts the base artifact to it.
- `evidence/` — three real discovery runs (a clean success; an escalation resolved with
  `abort` against a nonexistent member, with a real intervention screenshot/log; and an
  escalation resolved with `resume` against a permission-denied member, where the run
  continues on the same live session and actually completes the goal afterward), a real
  artifact, its confidence/approval registry, and real replay runs covering success, a
  recovered session-timeout, "member not found," "permission denied," a validation error,
  simulated slow load, the draft→approved gating flow, a genuine `failure` result (an
  account type the app's dropdown doesn't offer, with no known outcome to explain it), and
  the cross-tenant reuse pair described in step 6 below (the same artifact succeeding
  against a rebranded second tenant via an override, and failing against it without one).
- `Dockerfile.mock-bank` / `Dockerfile.capability-api` / `Dockerfile.dashboard` +
  `docker-compose.yml` — containerizes the three long-running services (see "Running via
  Docker Compose" below); the interactive, headed-browser demo scripts stay host-only.
- `.github/workflows/ci.yml` — typecheck + test + dependency-audit on every push/PR to
  `main` (see "Continuous integration" below).
- `SECURITY.md` — the consolidated threat model, auth design, and guardrail/escalation
  summary; `.env.example` — every environment variable this repo uses, documented with a
  placeholder, safe to commit (real values go in `.env`, which is git-ignored).

## Setup

Requires Node.js >= 20.

```bash
npm install
npx playwright install chromium   # one-time browser download
```

Copy `.env.example` to `.env` (git-ignored, never committed) and fill in real values:

```bash
cp .env.example .env
```

```
GEMINI_API_KEY=your-key-here
# optional -- defaults to gemini-3.7-flash. Free-tier daily quotas on Gemini's flash models
# are small (single digits to low tens of requests/day) and a ~10-step discovery run can
# exhaust one in a single attempt; the code retries 429s with backoff, but once a model's
# whole daily quota is gone, no amount of retrying the same model helps. As of this pass,
# every real Gemini call falls back to GEMINI_FALLBACK_MODELS automatically when that
# happens -- see "Gemini quota fallback" below -- so switching this by hand is now a manual
# fallback, not the only one. The evidence in this repo was itself produced on
# gemini-3.5-flash-lite after several other models hit their daily cap during testing.
GEMINI_MODEL=gemini-3.7-flash

# Optional, comma-separated, tried in order after GEMINI_MODEL. Every real Gemini call in
# this repo now falls back to the next model here the moment it detects GEMINI_MODEL's
# *daily* quota is exhausted specifically (a per-minute rate limit still just backs off and
# retries the same model, same as before) -- see "Gemini quota fallback" below. Leave unset
# to keep the single-model behavior.
GEMINI_FALLBACK_MODELS=gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.0-flash

# Required to start the capability API and dashboard -- both now refuse to start without
# these set (see SECURITY.md "Authentication"). Generate your own; don't reuse the
# placeholder in .env.example.
CAPABILITY_API_KEY=generate-a-random-value
DASHBOARD_PASSWORD=generate-a-random-value
```

Get a Gemini key at https://ai.google.dev. `CAPABILITY_API_KEY`/`DASHBOARD_PASSWORD` are
yours to generate, e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
Plain `npm run replay` and `npm run mock-bank` need neither -- replay never calls the model,
and mock-bank is the target app, not one of the two secured surfaces.

These two env vars are consumed indirectly via `config/operators.json`'s `local-operator`
entry -- a real, named operator identity, not just a shared secret, that now shows up in
this run's evidence log and (via `compliance-report`) an "Operator:" line. Nothing else to
configure for a solo setup; see `SECURITY.md` "Authentication" to add a second named
operator or attribute the chat UI's own outbound calls to a distinct `chat-ui-service`
identity via `CHAT_UI_SERVICE_API_KEY`.

### Gemini quota fallback

`src/agent/model-retry.ts`'s `withModelFallback` (used by discovery, the conversational
front end's planner, and assisted/vision recovery -- every real Gemini call in this repo)
distinguishes two failure modes that used to be handled identically:

- A **per-minute rate limit** (`429`, no `PerDay` in the quota id) -- still just backs off
  and retries the *same* model, exactly as before. Waiting genuinely helps here.
- A **daily quota exhaustion** (`429`, quota id contains `PerDay`) -- backing off cannot
  help until tomorrow, so the very next attempt uses the next model in
  `GEMINI_FALLBACK_MODELS` instead, with no wasted wait. If every configured model is
  exhausted, the error says so explicitly (`All configured Gemini models (...) have
  exhausted their daily quota`) instead of a bare timeout.

This re-checks from `GEMINI_MODEL` (not the last model that worked) on every new discovery
step or invocation -- deliberately: a run only makes a handful of these calls, so the worst
case is one extra fast-failing request to an already-exhausted primary per step, not a
meaningful delay, and that's a simpler design than persisting which model last worked across
calls for a saving this small.

**If you have no fallback models configured (or all of them are also exhausted) mid-demo:**
edit `GEMINI_FALLBACK_MODELS` (or `GEMINI_MODEL`) in `.env` and re-run the command -- nothing
else needs to change, since every entry point reads the model list fresh at process start.

## Demo path

Everything below assumes you're in the repo root.

**1. Start the target app** (a separate terminal, keeps running):

```bash
npm run mock-bank
# -> mock-bank listening on http://localhost:4000
```

**2. Run the discovery agent** against a real goal. This launches a real (headed) Chromium
window, drives it with Gemini, and on success writes evidence + a capability artifact:

```bash
npm run run-agent
```

By default this runs the goal *"Sign on as operator demo_operator / demo_password, look up
member 10001, open a new Savings sub-account with an initial deposit of $100, and reach the
confirmation screen."* You'll see one confirmation prompt in the terminal -- opening a
sub-account is a classified-`risky` (write) action, so the guardrail layer pauses for
explicit confirmation before submitting it, exactly as it would in production:

```
=== RISKY ACTION REQUIRES CONFIRMATION ===
POST /members/10001/sub-accounts is classified risky and requires confirmation.
Type 'yes' to proceed, anything else to decline:
```

Type `yes` and press Enter. On success you'll see:

```
Discovery finished with status: finished
Evidence written to: evidence/runs/discovery-<timestamp>
Artifact written to: evidence/artifacts/open-sub-account.artifact.json
```

Useful flags: `--goal "..."`, `--start-url http://localhost:4000/login`, `--headless true`
(no visible window -- but then a real escalation handoff has nothing to hand control of),
`--artifact-out path.json`.

**2b. See a real escalation resolved with `resume`, not just `abort`.** Every other
escalation scenario in this repo ends the run; this one shows a human handing control back
and the goal actually completing afterward on the same session:

```bash
npm run escalation-resume-demo
```

This drives a goal against a permission-denied member (`99999`) -- not something automation
can route around on its own, and not something fixable server-side either. What a human
operator *can* do is redirect the same live browser to a member they're actually permitted
to serve; since this process has no mouse to hand to an actual human, that one action is
scripted (see the header comment in `src/cli/escalation-resume-demo.ts`), but the pause, the
resume decision, Gemini re-observing the new page, and it finishing the goal from there are
all real:

```
Discovery finished with status: finished
Summary: Successfully escalated when member 99999 was denied, and upon return, opened a new
Savings sub-account for member 10001 with an initial deposit of $100. Confirmation SA-00001
displayed.
```

**3. Replay the resulting artifact** -- deterministically, with no LLM call, against fresh
input params (the mock app resets sub-account state via `POST /__test__/reset`, a
test-only endpoint, if you want a clean slate between runs):

```bash
curl -s -X POST http://localhost:4000/__test__/reset

npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

`--allow-risky true` is the unattended-production-replay opt-in for this artifact's risky
step (see `REPORT.md` "Safety"); omit it to get an interactive confirmation prompt instead,
same as discovery. **It's only honored once the artifact is `approved`** (see step 5) — on a
freshly recorded artifact it's ignored and you'll still be prompted.

**4. See a real error/exceptional-state replay.** The mock app has several deterministic
trigger IDs baked in (see `apps/mock-bank/src/data.ts`):

| memberId | Result |
|---|---|
| `10001`, `10002` | happy path |
| `40404` (or any unseeded ID) | `business_outcome: member_not_found` |
| `99999` | `business_outcome: permission_denied` |
| `55555` | 3s simulated slow load (handled transparently) |
| `90909` | session times out **once** mid-flow, then automation re-authenticates and retries -- a `recoverable` condition, not a failure |
| any memberId + `initialDeposit` under `25` | `business_outcome: validation_error` |

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"40404","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

```json
{
  "status": "business_outcome",
  "outcome": "member_not_found",
  "description": "No member exists with the given memberId. A legitimate result, not a crash.",
  "stepId": "step-6"
}
```

Real recorded examples of all of the above are already checked into `/evidence`.

**4b. See a real (not simulated) `failure` result.** The three-way replay contract's third
leg -- "nothing in `knownOutcomes` explains this" -- needs a genuinely unanticipated
deviation, not a business outcome. Requesting an `accountType` the app's dropdown doesn't
actually offer is exactly that:

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

This also lowered the approved artifact's confidence score for real -- see step 5.

**4c. See that same three-way contract's fourth possibility: a human resuming a REPLAY hard
failure, not just discovery's.** Step 2b showed discovery resuming after a human intervenes;
until now, replay -- the brief's own "production execution path" -- had no equivalent, so a
genuinely unanticipated hard failure like 4b's just ended the run. `apps/mock-bank`'s
`requiresInterstitialConfirmation` scenario (member `77777`) simulates the brief's own named
"unexpected confirmation dialog" (Section 1): opening a sub-account renders an interstitial
the recorded artifact never accounted for, so step-10's checkpoint genuinely fails with
nothing in `knownOutcomes` to explain it:

```bash
curl -s -X POST http://localhost:4000/__test__/reset
npm run escalation-resume-replay-demo
```

Real, not simulated: the pause, the resume decision routed back into `replay()`, and the run
completing afterward on the same session with a real confirmation number. Scripted, and
disclosed as such (see the header comment in `src/cli/escalation-resume-replay-demo.ts`): the
one click a human would make to dismiss the interstitial, since this process has no mouse to
hand to an actual person.

```
Replay finished with status: success
{
  "status": "success",
  "outputs": { "confirmationNumber": "SA-00001" }
}
```

The same capability is available as a plain CLI flag for any artifact/params, not just this
one scripted scenario -- `npm run replay -- ... --interactive-escalation true` offers a human
at the terminal the same one-shot resume-or-abort choice on any genuine hard failure. Omitted
by default everywhere (same opt-in posture as `--assisted-recovery`): an unattended caller
(the capability API, `canary-check`) has no human to hand a stuck run to, so it keeps failing
immediately unless this is explicitly turned on.

**4d. The same real handoff, reachable from the console -- no terminal, no scripted click.**
The two paths above prove the mechanism; neither is something a person watching the chat
console would ever see triggered from a demo-script button. `src/api/http-escalation.ts`
closes that gap: the capability API's own `onEscalate` now pauses on an in-memory
promise instead of declining automatically, exposed as `GET /interventions` (what's paused,
with a live screenshot) and `POST /interventions/:id/resolve` (`resume`/`abort`) -- proxied
through the console at the same two paths. The original `/invoke` (and therefore `/chat`)
request that triggered the escalation stays open, blocked, until a human answers.

```bash
npm run capability-api    # headed by default -- the live browser window is really visible
npm run chat-ui
```

Open `http://localhost:4800`, ask *"Open a savings account for member 77777 with $50"*, confirm
with "yes". A red intervention card appears in the console with the live screenshot, the
reason, and Resume/Abort buttons -- while a REAL headed Chromium window is genuinely sitting
on the interstitial page on your own screen. Click **"Confirm & Continue" in that real
window** (not scripted this time), then click **Resume** in the console: the blocked chat
reply completes for real with a genuine confirmation number. Click **Abort** instead (with or
without touching the browser) to see the clean, structured failure that produces. Verified
both ways live: `resume` without touching the page first correctly re-fails
(`"observed": "No locator candidate resolved to an element."` -- the interstitial's Submit
button no longer exists once you've moved past it, exactly as it shouldn't); `abort` reports
`"observed": "url=http://localhost:4000/members/77777/sub-accounts"`, the same clean failure
shape as every other hard failure in this system. A pending intervention nobody answers times
out to `abort` after 10 minutes rather than hanging a real browser and a rate-limit slot
forever.

**5. Confidence & approval (Section 8 stretch goal).** Every replay records its outcome
against the artifact's exact content fingerprint in `evidence/artifacts/registry.json`, and
computes a confidence label (`unproven` → `low`/`medium` → `high`) from clean-run history
(`success` and `business_outcome` both count as "the artifact behaved correctly"; only a
`failure` counts against it). A freshly recorded artifact starts in `draft`, where
`--allow-risky` is silently ignored and risky steps always require interactive confirmation
— exactly what step 3 demonstrated. Run a few replays to build up history, then approve it:

```bash
npm run approve -- --artifact evidence/artifacts/open-sub-account.artifact.json
```

```
Artifact: Open Sub-Account v1.0.0 (006fd53ee041c1ca)
Current approval state: draft
Confidence: high (8/8 clean runs)

Approved. --allow-risky will now be honored for this exact artifact content on replay.
```

(The exact fingerprint above is from the real `evidence/artifacts/registry.json` checked
into this repo -- yours will differ once you record your own artifact. The checked-in
registry currently reads `medium (8/9 clean runs)`, not `high (8/8)`, because step 4b above
was deliberately run against it to produce a real `failure` entry -- see "Confidence &
approval" in `REPORT.md` for why the approval state itself does *not* automatically revoke
when that happens.)

Now `--allow-risky true` runs fully unattended — no prompt, no stdin needed at all:

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true < /dev/null
```

The registry is keyed by a content fingerprint (a hash of the artifact's steps/params/
outputs/checkpoints, excluding cosmetic fields like `createdAt`), not just `id`+`version` —
so a re-recorded artifact with materially different steps starts back at `draft`/`unproven`
automatically, rather than silently inheriting an approval it never earned. Use
`npm run approve -- --artifact <path> --revoke true` to send an artifact back to draft.

**6. Cross-tenant reuse (Section 8 stretch goal).** The same artifact recorded against
`mock-bank` on port 4000, replayed against a *second*, differently-branded tenant on port
4100 running the identical underlying app -- no re-recording, just a small named override.

```bash
npm run mock-bank:northgate
# -> mock-bank listening on http://localhost:4100 (tenant: northgate-cu)
```

```bash
curl -s -X POST http://localhost:4100/__test__/reset

npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/northgate-cu.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```

Type `yes` at the risky-action prompt (this artifact's own fingerprint on this tenant starts
back at `draft` -- see below). This completes end to end against a page that says "Log In"
instead of "Sign On," "Find Member" instead of "Look Up Member," and "Confirm & Open" instead
of "Submit" -- real evidence at `evidence/runs/replay-2026-08-25T17-52-53-914Z`.

To see that the override is actually load-bearing and not just a URL pointer, the same base
artifact run against `:4100` with a `baseUrlPattern`-only override and no locator/checkpoint
patches (`config/tenant-overrides/_negative-control-url-only.json`) fails at `step-4`
("No locator candidate resolved to an element") -- `evidence/runs/replay-2026-08-25T17-58-23-091Z`.
Worth noting honestly: the five plain form-field steps (username/password/memberId/
accountType/initialDeposit) keep working on the variant even *without* an override, because
this app happens to give those inputs `id` attributes and this system's `css_structural`
locator candidate collapses to `#id` when one is present -- a real (if narrow) source of
free resilience to rebranding, and also why `northgate-cu.json` only patches the four
steps that don't have that safety net (the Sign On/Look Up Member/Open New Account/Submit
controls). See REPORT.md "Heterogeneity & multi-tenant" and "Stretch goals" for the full
design and why the override is deliberately restricted to copy, not flow structure.

**7. UI-drift signal.** Every replay already logs which locator strategy actually resolved
per step; this diffs that against what was recorded, across whatever replay runs exist for
this exact artifact content:

```bash
npm run drift-report
```

Run against this repo's own checked-in evidence, it surfaces something real: `step-2`/
`step-3` (the Operator ID/Password fields) show a fallback to `css_structural` on the run
that hit the rebranded northgate-cu tenant *without* the locator override -- because those
two fields happen to carry `id` attributes, so the structural fallback quietly covered for
the mismatched `role`/`text` candidates (see step 6's honesty note). `step-11` is flagged on
every run for an unrelated, harmless reason: its `text` candidate is the literal
confirmation number observed at *recording* time, which by construction never matches again.
See `REPORT.md` "Determinism & error handling" for both, and why the second one is a known
false-positive category rather than a real drift signal.

**7b. Self-healing locator proposals.** Closes the loop between the drift signal above and
cross-tenant reuse (step 6): instead of a human re-deriving "which steps need an override"
from the drift-report printout by hand, this generates the override's *shape* automatically
-- which steps, which strategy -- while leaving the actual corrected `name` as an explicit
`TODO`, since drift data only tells you which locator *strategy* won, never what the correct
current accessible name/text actually is. Never writes a real, approvable
`config/tenant-overrides/<tenantId>.json` directly -- always a `.proposed.json` sibling, so
it can't be silently picked up by `replay --tenant-override`/`approve` without a human first
reviewing and renaming it:

```bash
npm run propose-override -- --tenant-id northgate-cu-url-only-negative-control
```

Run against this repo's own checked-in evidence, this finds the exact same three drifting
steps step 7's `drift-report` flags (Operator ID/Password/Member ID) and writes a scaffold
to `config/tenant-overrides/northgate-cu-url-only-negative-control.proposed.json` with a
`TODO:` placeholder `name` for each one -- real output, not a hypothetical.

**8. Capability dashboard.** One page that renders everything above -- contract, approval/
confidence, drift, and a discovery-vs-replay time/model-call comparison -- instead of four
separate commands:

```bash
npm run dashboard
# -> Capability dashboard listening on http://localhost:4600
```

Open `http://localhost:4600` in a browser -- it'll prompt for a username and password:
`operator` and your `DASHBOARD_PASSWORD` from `.env` for the default solo-dev setup (a
presented username now resolves to a specific named entry in `config/operators.json`, not
"anything" -- see `SECURITY.md` "Authentication"); that's real HTTP Basic auth, not a demo
placeholder. It reads straight from `evidence/artifacts/` and
`evidence/runs/` on every request (no writes, no state of its own), so it stays accurate
while you run more discovery/replay/approve commands in other terminals and just refresh.
Two things worth pointing at: a second confidence badge appears ("drift-capped to ...")
whenever any step's UI-drift signal (§3) would otherwise leave a misleadingly-high
label unchallenged; and a "Tenant variants" table lists every `config/tenant-overrides/`
entry for this capability with its *own* approval/confidence state -- a tenant override
never exists as a file under `evidence/artifacts/`, so without this the dashboard would only
ever show the base artifact, not the tenants actually running on top of it.

**9. Agent-facing capability interface (Section 8 stretch goal).** The seam Section 1
describes -- "the agent-facing product decides what to do; this system is how it reliably
and safely does it" -- as an actual HTTP surface:

```bash
npm run capability-api
# -> Capability API listening on http://localhost:4700

npm run agent-invoke-demo
```

The demo script discovers capabilities via `GET /capabilities`, then invokes
`open-sub-account` by name with typed args via `POST /capabilities/:id/invoke` -- exactly
like an AI agent would. If the artifact is still `draft`, the risky step (opening the
account) is declined automatically over HTTP, the same as the CLI would without
confirmation -- there's no operator to prompt on an unattended API call. Run `npm run
approve -- --artifact evidence/artifacts/open-sub-account.artifact.json` first to see it
complete end to end with a real confirmation number instead:

```bash
npm run agent-invoke-demo -- --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```

Real evidence for all four legs of the contract over HTTP -- declined-risky (422),
success (200), business_outcome (200), and a parameter-validation error (400) -- is in
`evidence/runs/replay-2026-08-25T18-3*`. Both `agent-invoke-demo` and `agent-chat` (step 11)
read `CAPABILITY_API_KEY` from `.env` and send it automatically; calling the API directly
(e.g. with `curl`) needs `-H "Authorization: Bearer $CAPABILITY_API_KEY"` -- see
`SECURITY.md` "Authentication" for why this is now a real gate, not a local-demo-only
placeholder.

**Tenant-aware invocation.** The invoke body also takes an optional `tenantId`, applying
that tenant's override (from step 6) before replaying -- so an agent can ask for a specific
tenant's variant of a capability over HTTP, not just the base artifact. It has its own
independent approval state, same as replaying it via the CLI, so approve that exact content
first (note the extra `--tenant-override` flag, mirroring `replay`'s):

```bash
npm run mock-bank:northgate     # if not already running

npm run approve -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/northgate-cu.json

curl -s -X POST http://localhost:4100/__test__/reset

npm run agent-invoke-demo -- --tenant northgate-cu \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```

Real evidence: declined while the tenant's fingerprint was still `draft`
(`replay-2026-08-25T19-04-57-509Z`, 422), then a real confirmation number once approved
(`replay-2026-08-25T19-05-46-142Z`, 200).

**10. Confidence circuit breaker.** Confidence isn't just a dashboard badge -- an `approved`
artifact whose drift-adjusted confidence has degraded to `low`/`unproven` falls back to
attended confirmation for risky steps, the same as a `draft` one, regardless of
`--allow-risky`:

```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

If this artifact's confidence is currently drift-capped (check with `npm run drift-report`),
you'll see `--allow-risky was requested but ignored: this artifact is approved, but
UI-drift has capped its confidence...` and a normal confirmation prompt, distinguished in
the console output from the separate "not enough of a track record yet" case.

**10b. A second, independent capability -- enrolling a brand new member, not acting on an
existing one.** Everything above this line is one capability's full lifecycle. This proves
the system generalizes to a second real one, recorded with its own genuine discovery run:

```bash
npm run mock-bank    # if not already running
npm run run-agent-create-member
```

Records `evidence/artifacts/create-member.artifact.json` -- its own typed contract
(`fullName`, `initialChecking`, `initialSavings`), its own `validation_error` known outcome,
its own draft→approved lifecycle. Replay it exactly like step 3-4b, just with this
artifact and these params:

```bash
npx tsx src/cli/replay.ts --artifact evidence/artifacts/create-member.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","fullName":"Priya Nair","initialChecking":"1000","initialSavings":"250"}' \
  --allow-risky true
```

**10c. A third capability, entirely read-only.** No new mock-bank route at all -- the member
page already shows both balances; the discovery run just has to reach it and extract them:

```bash
npm run run-agent-check-balance
```

Records `evidence/artifacts/check-balance.artifact.json` -- every step is `safe` (all GET),
so replay never prompts for confirmation at all, unlike the other two:

```bash
npx tsx src/cli/replay.ts --artifact evidence/artifacts/check-balance.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001"}'
```

**10d. A fourth capability, moving a member's own money between their two balances.** A new
mock-bank route (`/members/:id/transfer`), and two distinct business outcomes --
`insufficient_funds` and `invalid_transfer` (bad amount, or the same account on both sides):

```bash
npm run run-agent-transfer-funds
npx tsx src/cli/replay.ts --artifact evidence/artifacts/transfer-funds.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","fromAccount":"Checking","toAccount":"Savings","amount":"100"}' \
  --allow-risky true
```

**10e. A fifth capability, closing an existing sub-account -- and a real bug this one
surfaced.** The member page originally hid the "Close" link once an account was already
closed, which meant *replaying the same recorded artifact twice* couldn't even reach the
form the second time -- a hard failure ("no locator resolved"), not the intended
`already_closed` business outcome. Fixed by keeping the link reachable regardless of status
(a real bank's legacy UI often does exactly this) and letting the *server* report
"already closed," not the link's absence. Needs a member with an existing sub-account first:

```bash
npm run mock-bank    # if not already running
npx tsx src/cli/replay.ts --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"200"}' \
  --allow-risky true

npm run run-agent-close-sub-account
npx tsx src/cli/replay.ts --artifact evidence/artifacts/close-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002"}' \
  --allow-risky true
```
Replay the exact same command a second time to see the real `already_closed` business
outcome instead of a crash.

**10f. Recording a new capability without writing a new source file.** Each capability above
needed its own `run-agent-*.ts` wrapper plus, usually, its own `src/cli/capabilities/*.ts`
domain-knowledge file (param mappings, the success checkpoint, known outcomes, and which
steps get which intermediate checkpoint). `record-capability` reads that same domain
knowledge from one JSON config instead:

```bash
npm run record-capability -- --config config/capability-configs/mock-bank-check-balance.example.json
npm run record-capability -- --config config/capability-configs/meridian-check-balance.example.json
```

The two example configs shipped here reproduce `check-balance` and `meridian-check-balance`
field-for-field (see `src/cli/record-capability.test.ts`, which loads and asserts against
both) -- running either one re-records that same capability for real, exactly like its
hand-written `run-agent-*` script would. `--goal`, `--start-url`, and `--artifact-out` on the
command line override the config file's own values, the same way every hand-written wrapper
already lets you override its default goal.

This does **not** make param mappings or known outcomes up for you -- those stay hand-authored
domain knowledge, same as every other capability in this repo (see `recorder.ts`'s own doc
comment on why that's a deliberate choice, not a gap). What it removes is having to write a
new `.ts` file to hold that knowledge: describe a capability as one JSON file (steps'
checkpoint-annotation rules included -- `checkpointAnnotations` covers the exact two matcher
primitives, `isClickNamed`/`isClickMatching`, every existing `annotate*Checkpoints` function
in this repo already reduces to) and this script drives the same `runDiscoveryCli()` engine
every other capability uses. Recording a brand-new capability against a brand-new target is
then: write one config JSON (see the two examples for the field-by-field shape), point
`startUrl`/`baseUrlPattern` at it, and run this.

**11. Conversational front end.** The other half of "the agent-facing product decides what
to do": natural language, mapped to a capability + typed args by one Gemini call, then
invoked through the same capability API as step 9. With three real capabilities now
discoverable, this is also where a request actually gets to choose -- "look up member
10001" and "create a new member named ..." resolve to different capabilities, decided by
the model, not hardcoded.

```bash
npm run capability-api    # if not already running
npm run agent-chat -- --message "Using operator demo_operator and password demo_password, open a savings account for member 10001 with a starting deposit of 100 dollars"
```

The model picks `open-sub-account` and the right typed params from plain English; execution
and the final report stay fully deterministic -- no second LLM call phrases the result. Try
a request that mentions a tenant by name (e.g. "...at Northgate Credit Union") to see
`tenantId` get picked up too.

**11b. The same front end, as a real chat (+ voice) UI, not just a CLI.** A member-facing
web page instead of a one-shot command -- same `runChatTurn()` underneath (shared with step
11's CLI, not a second implementation):

Needs **two** other services already running first -- the chat UI calls the capability API,
which drives mock-bank -- not just itself:

```bash
npm run mock-bank         # if not already running (step 1)
npm run capability-api    # if not already running (step 9)
npm run chat-ui
```

If you skip either of the first two, the chat UI itself starts fine (it has nothing to
connect to yet), but every message fails with "Couldn't reach the capability API" -- that
error names exactly this cause.

Open `http://localhost:4800`. Type (or, in Chrome/Edge, click the mic and speak) a request
like *"Open a savings account for member 10001 with $100"* -- no credentials needed in the
chat: `src/chat-ui/server.ts` injects its own configured service-account operator
credential (`CHAT_UI_OPERATOR_USERNAME`/`PASSWORD`, defaulting to the same demo credential
used everywhere else in this repo) *after* planning and *before* invoking, so a customer's
chat text is never what actually authenticates against the target system -- the same reason
`planner.ts` excludes sensitive params from the model's function-calling contract in the
first place, closed all the way to the front door. Voice is entirely client-side (the
browser's own Web Speech API for speech-to-text and text-to-speech) -- no audio is ever sent
anywhere, no new backend service exists to support it, and the mic button hides itself
entirely on a browser that doesn't support it rather than failing silently.

Ask it to create/change something (open an account, create a member, transfer funds, close
an account) and it won't act right away -- it replies with a plain-language summary of
exactly what it's about to do and waits for you to type "yes" or "no" before actually
invoking anything. A plain read (e.g. "what's the balance for member 10001") answers
immediately, with no confirmation step. See
[`docs/15-conversational-frontend.md`](docs/15-conversational-frontend.md)'s "Confirm before
executing anything risky" for how this is implemented (`hasRiskyStep` on each capability,
`planChatTurn`/`invokePlannedTurn`, and a short-lived server-side session holding the pending
plan across that one confirmation round-trip).

You can also chain two steps in one message -- try *"create a new member named Priya Nair,
then open a savings account for them with $100."* This detects the chain with a
deterministic text split (no model call), plans both clauses, confirms both together in one
message, and -- only on "yes" -- invokes step 1 for real, splices its actual output (the new
member id) into step 2's params, and invokes step 2. Fails fast (never invokes step 2) if
step 1 doesn't cleanly succeed. See `docs/15-conversational-frontend.md`'s "Chained
requests" for the real bug this surfaced live (planning the second clause in complete
isolation made Gemini correctly refuse to call any function at all) and how it was fixed.

**11c. One page, one port, every target (the unified demo console).** `http://localhost:4800`
is the single entry point for a live demo -- not just the chat panel, and not one process per
target either. The sidebar has three things:

- A **target switcher** at the top -- "Mock Bank" / "MERIDIAN CORE (teller)" / "MERIDIAN CORE
  (supervisor)" -- backed by a small `TARGETS` registry in `src/chat-ui/server.ts`, each entry
  naming its own capability-api instance, its own signed-on operator identity, its own
  demo-script file, and its own dashboard link. Clicking one `POST`s `/target`, which sets
  `activeTargetId` on that browser's own session (the same session mechanism already holding
  `pendingPlan`/`pendingChain`) -- every other route (`/chat`, `/catalog`, `/config`) reads it
  back per-request, so one process genuinely serves every target, not three copies of the same
  server on three ports. Switching clears any pending confirmation/chain/history: a different
  target means a different capability catalog and a different identity underneath, so
  anything pending against the old one would be actively wrong against the new one, not just
  stale. The MERIDIAN teller/supervisor pair is the same backend and catalog, just a different
  `fillParams` identity (`teller1` vs `super1`) -- proof the switch is real: ask it to place a
  hold as the teller and it comes back `supervisor_override_required`; switch to supervisor,
  ask again, and it actually posts.
- A live **capability catalog** (name, approval state, confidence, a `risky` badge) for
  whichever target is active, fetched from `GET /catalog` -- a redacted read-through of that
  target's own capability-api `GET /capabilities` that never hands the browser an API key of
  its own.
- A **"Demo scripts"** list of buttons, one JSON file per target
  (`config/demo-scripts/mock-bank.json`, `meridian.json`, `meridian-supervisor.json`),
  covering every capability's happy path plus its real business outcomes, not just one or two
  examples -- mock-bank's covers all five capabilities including the genuine
  `permission_denied` (member `99999`), `member_not_found`, simulated-slow-load, and
  interstitial-hard-failure seed scenarios `apps/mock-bank/src/data.ts` ships; MERIDIAN's
  covers all six capabilities including `invalid_email_format`, the certificate
  minimum-deposit business rule, and the teller/supervisor Place Hold split. Clicking one adds
  no new invocation logic: it fills the same composer input a person would type and submits it
  through the unchanged `/chat` path, so a scripted demo step and a free-typed request are
  indistinguishable to the server.

An "Open ops dashboard ↗" link (from `GET /config`) points at whichever target's dashboard is
active. `npm run chat-ui` is the only command needed -- the built-in `TARGETS` default already
covers mock-bank (`:4700`/`:4600`) and both MERIDIAN identities (`:4701`/`:4601`); a
`CHAT_UI_TARGETS_FILE` env var fully replaces that list for a different port layout or a real
third target.

A fourth thing shows up only when it's needed: if a request hits a genuine mid-replay hard
failure, a red **intervention card** appears above the chat log -- a live screenshot, the
reason, and Resume/Abort buttons, polled from `GET /interventions` every 2.5s. This is the
real human-escalation handoff (§3.6), reachable from the console instead of only a terminal
-- see "4d" below for the full walkthrough.

**12. Assisted fallback (bounded LLM recovery).** Opt-in only -- `replay`'s own promise
("never calls a model") holds unless you pass this:

```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/_negative-control-url-only.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}' \
  --assisted-recovery true
```

This points the *unmodified* base artifact at the rebranded northgate-cu tenant (mock-bank
running with `TENANT=northgate-cu` on port 4100 -- see step 6) with no locator overrides at
all, so several steps genuinely fail to resolve. With `--assisted-recovery true`, one bounded
Gemini call per failed step proposes a correction (e.g. recognizing "Log In" now stands in
for "Sign On") and gets past it for real -- or reports the original failure if the model
call itself fails or can't find anything usable. Never auto-executes a risky step; you'll
be prompted, same as any other risky action.

**13. Vision-grounded fallback.** A dedicated negative-control fixture --
`apps/mock-bank`'s `/legacy-widget-demo`, a button drawn entirely on a `<canvas>` with no
DOM semantics at all, standing in for a screen-shared legacy terminal:

```bash
npm run vision-fallback-demo
```

The "recorded" step targets the button by role+name (as any DOM-based recorder would),
which genuinely fails to resolve. `attemptAssistedRecovery` is then invoked directly: one
real Gemini call, given both the DOM observation (empty) and a screenshot, correctly
recognizes there's nothing DOM-addressable and proposes `click_at_coordinates` instead.
Real evidence has shown both a full success and a real, honest miss (the coordinate lands
slightly outside the button's actual bounds) -- pixel-level vision grounding is inherently
imprecise, which is exactly why this stays a last-resort fallback behind DOM-based recovery,
not a primary strategy. See `REPORT.md` "Assisted fallback" for both real outcomes.

**14. Multi-run stability (Section 8 stretch goal).** One real, unattended replay through
the exact same guardrails/circuit breaker as any other caller, followed by a health
read-out over the artifact's most recent replay history -- meant to be invoked on a
schedule (a real crontab entry, deliberately not built per the brief's own "don't build
scaling infrastructure you don't need" -- the script itself is real and runnable today):

```bash
npm run canary-check -- --headless true
```

```
Result: success
Stability (last 5/5 runs): 3 clean, 2 failed -- FLAKY
```

That's a real read against this repo's own accumulated history, not a staged clean run --
see `REPORT.md` "Multi-run stability" for why reporting the honest `FLAKY` result (and
exiting 1, checked directly, not through a pipe) is the correct behavior for a tool whose
entire job is telling the truth about health.

Each invocation also appends its own outcome to a dedicated trend log
(`evidence/canary-history.jsonl` by default, `--canary-history <path>` to override) and
prints a `Trend:` line -- three consecutive unhealthy *canary* checks in a row (not just any
replay traffic) exits `3` with a `REGRESSING` flag, distinct from a single flaky run. See
`docs/17-multi-run-stability.md`'s "Trend over time" for why this needed its own log rather
than reusing the registry's shared replay history.

**15. Compliance/audit export.** Not a Section 8 stretch goal -- presentation on existing
evidence, same category as the dashboard. Turns every run's already-redacted evidence into
a report for a bank's compliance/audit function:

```bash
npm run compliance-report -- --out compliance-report.md
```

Run against this repo's own full history, it produces run counts by type/outcome, a
risky-action approval/decline breakdown, and a per-run detail section -- and discloses
directly in its own header that this system doesn't record *which human* approved a risky
action, only *that* one did and when (see `REPORT.md` "Safety" and "A non-stretch-goal
addition: compliance audit export").

## MERIDIAN CORE adaptation demo path

Everything above is the take-home system, driving the local `mock-bank` app. This section
points the exact same core at a real, live, hosted legacy target -- MERIDIAN CORE, a
credit-union servicing console at `https://web-sample.interface-hiring.com` -- with no code
changes beyond the handful named in `ADAPTATION.md`. Read that file first for what
adapting actually took and why; this section is just the commands.

No local app to start -- the target is already live. Six capabilities are recorded and
approved under `evidence/artifacts-meridian/`, covering the brief's full function list
(sign-on is embedded as the first steps of every capability, matching the take-home's own
`create-member` precedent):

| Capability | Kind | Artifact |
|---|---|---|
| `meridian-check-balance` | read | member lookup by number, first share row's balance/status |
| `meridian-member-search` | read | search by member number *or* last name |
| `meridian-transfer-funds` | write, review→post, irreversible | **minimum-bar #2** |
| `meridian-open-share` | write, review→post | |
| `meridian-update-member` | write, single direct POST (no review step) | |
| `meridian-place-hold` | write, review→post, supervisor-gated | records with `super1` |

Re-record any of them for real against the live target (each needs `GEMINI_API_KEY`; risky
writes prompt for confirmation -- pipe an *unbounded* `yes`-style stream if scripting more
than one confirmation in a row, not a fixed `printf`, see `ADAPTATION.md`'s "what was cut"):

```bash
npm run run-agent-meridian-check-balance
npm run run-agent-meridian-transfer-funds
```

Replay any of them deterministically, against the correct MERIDIAN registry (the
`--registry` flag matters -- it defaults to the mock-bank one otherwise):

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-check-balance.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100234"}'

npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-transfer-funds.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100987","fromShare":"100987-S0001","toShare":"100987-MMKT-3","amount":"5.00"}' \
  --allow-risky true
```

A clean exceptional state, live -- a teller attempting the supervisor-only Place Hold:

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-place-hold.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"102777","shareId":"102777-S0001","reasonCode":"LEGAL","notes":""}' \
  --allow-risky true
```

Returns `status: "business_outcome"`, `outcome: "supervisor_override_required"` -- a real
403 from the live app, not a guardrail block. Injected faults work the same way against any
capability, either per-request (`?inject=<kind>` appended to a URL you drive manually) or
globally via the live app's own `/settings` screen (`errorRate`, `forcedInject` -- remember
to reset `forcedInject` back to `""` afterward, since it's global and affects every other
session against the shared demo target).

**Capability API and dashboard, pointed at MERIDIAN's own catalog** -- a second instance of
each, mirroring the existing `northgate-cu` multi-tenant pattern (same server code, separate
config, see `ADAPTATION.md`). The chat/console layer needs no second instance at all -- one
`npm run chat-ui` already knows about both:

```bash
npm run capability-api-meridian   # port 4701, evidence/artifacts-meridian
npm run dashboard-meridian        # port 4601, same artifacts dir, HTTP Basic auth
npm run chat-ui                   # port 4800 -- the ONE console, for every target
```

(Earlier this repo ran a second `chat-ui-meridian` process on its own port, with its own
`CHAT_UI_OPERATOR_*` env vars. That's gone -- see "11c" above: one process now holds all
three identities (mock-bank, MERIDIAN teller, MERIDIAN supervisor) in a `TARGETS` registry and
switches between them per browser session. A real bug surfaced and got fixed on the way to
that design: the original two-process setup's documented MERIDIAN launch command never set an
operator credential at all, so it silently injected the *mock-bank* demo credential
(`demo_operator`/`demo_password`) into every MERIDIAN sign-on step -- not a valid MERIDIAN
operator, so every invocation would have failed at login. The `TARGETS` registry's
`meridian`/`meridian-supervisor` entries carry the correct `teller1`/`super1` credentials
built in, so this can't recur silently the way a forgotten env var could.)

Open `http://localhost:4800`, click **"MERIDIAN CORE (teller)"** in the sidebar's target
switcher, and the catalog/demo-scripts/dashboard-link all update to MERIDIAN's own -- all six
capabilities, and demo scripts covering every one of them (a balance check, a not-found
lookup, a name search, a transfer, an open-share happy path *and* its certificate
minimum-deposit business outcome, an update-member happy path *and* its invalid-email business
outcome, and a teller attempting the supervisor-only Place Hold). Ask it something like
*"what's the balance for member 100234"* or *"transfer $5 from share 100987-S0001 to
100987-MMKT-3 for member 100987"*, or just click a demo-script button -- the same
confirm-before-risky-action flow as the take-home's chat UI, just talking to MERIDIAN's
capability catalog. Click **"MERIDIAN CORE (supervisor)"** and ask the exact same Place Hold
question again: same backend, same catalog, only the signed-on identity changed (`super1`
instead of `teller1`) -- and it actually posts instead of coming back
`supervisor_override_required`, proof the switch is a real identity change, not cosmetic. The
sidebar's "Open ops dashboard ↗" link (or `http://localhost:4601` directly, HTTP Basic auth,
same `DASHBOARD_PASSWORD`) shows the run history, contract, and drift signal for all six
capabilities.

**The escalation demo.** A real, live, end-to-end proof of "stuck → stop → escalate," not
simulated: force a session-timeout mid-flow at a write capability's risky `/post` step (via
the live app's `/settings` screen, timed to land after sign-on/review already succeeded),
and -- because the write capabilities deliberately carry no `session_timeout` recovery --
watch it fall through to a real `requestIntervention` prompt instead of a silent retry or a
hang:

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-transfer-funds.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100987","fromShare":"100987-S0001","toShare":"100987-MMKT-3","amount":"1.00"}' \
  --interactive-escalation true
```

Type `yes` at the risky-action prompt, then -- in another terminal, before answering the
"HUMAN INTERVENTION REQUESTED" prompt that follows -- set the live app's global fault
injection to `timeout` via its `/settings` form (or drive it manually in a browser: sign on,
open `/settings`, select `timeout` under "Force error," Apply). The run correctly fails to
find a confirmation number on the resulting "YOUR SESSION HAS TIMED OUT" page, escalates for
real, and the only safe answer is `abort` -- there's nothing left to resume. Real evidence
from exactly this sequence: `evidence/runs/replay-2026-08-27T01-08-57-002Z/` (see
`ADAPTATION.md`'s "Safety, evidence, and escalation survival"). Remember to reset
`forcedInject` back to `""` afterward.

## Running without live services

The mock-bank app *is* the "live service" here -- there's no external dependency beyond
it and, for anything that calls Gemini, the Gemini API. Plain `npm run replay` needs
mock-bank running but never calls Gemini -- that's still the core, always-true promise.
Steps 11-13 (the conversational front end, assisted fallback, and vision fallback) are
opt-in extensions that *do* call Gemini, same as discovery; there's no way to demo any of
them without a real model call, same reasoning as discovery itself -- per the assignment
brief, that's intentional for discovery, and the same principle extends to anything that
puts a model back in the loop on purpose. Steps 14-15 (canary check, compliance report)
never call Gemini -- they're read-only over the deterministic replay engine and existing
evidence, same "replay never calls a model" promise as step 3.

## Running via Docker Compose

Containerizes the three long-running services -- mock-bank (both tenants), the capability
API, and the dashboard -- as an alternative to running each with its own `npm run` command.
Deliberately does **not** containerize `run-agent`, `escalation-resume-demo`,
`escalation-resume-replay-demo`, or `vision-fallback-demo`: those launch a real *headed*
Chromium window meant to be watched live, which can't run headless in a container; step
1-7 and 12-13 above still need the host
setup for that reason. `docker-compose.yml` builds `Dockerfile.mock-bank`,
`Dockerfile.capability-api` (runtime base `mcr.microsoft.com/playwright:v1.49.1-jammy`, so
the browser binaries baked into the image match this repo's `playwright` version -- no
`playwright install` step needed), and `Dockerfile.dashboard`.

```bash
cp .env.example .env   # fill in real values first, see Setup above
docker compose up --build
```

This starts mock-bank on 4000, mock-bank-northgate on 4100, the capability API on 4700, and
the dashboard on 4600 -- the same ports as running everything natively, so
`agent-invoke-demo`/`agent-chat`/`curl` against `http://localhost:4700` work unchanged
whether the capability API is containerized or run with `npm run capability-api`.
`evidence/` and `config/` are bind-mounted into the capability-api and dashboard containers,
so state written by one is visible to the other and to your host filesystem, same as running
natively. See `SECURITY.md` "Containers" for why `capability-api`/`mock-bank-northgate`/
`dashboard` all set `network_mode: "service:mock-bank"` (short version: the real, checked-in
evidence this repo replays against has literal `http://localhost:4000`/`:4100` baked in from
actual recording sessions, and this is how a container-launched Playwright browser gets
`localhost` to mean what that evidence expects, without rewriting real recorded data to fit
a deployment convenience).

**Not build-tested.** Docker wasn't available in the environment these files were produced
in (verified by directly attempting `docker --version`, not assumed) -- the `dist/` output
paths were confirmed by actually running `npx tsc` against this repo's real `tsconfig.json`,
and the base image tag was confirmed to exist via the registry API, but no image here has
gone through an actual `docker build`. Treat this path as reviewed-for-correctness, not
verified end-to-end the way every other command in this README has real evidence behind it.

## Continuous integration

`.github/workflows/ci.yml` runs on every push/PR to `main`: `npm run typecheck`, `npm test`
(the unit suite only -- it runs against a stub `Surface`, so no real Playwright browser is
needed in CI), and `npm audit --omit=dev --audit-level=high` as a real dependency-vulnerability
gate (currently 0 known vulnerabilities, so this is expected to pass, not decorative). One job,
no deploy stage, no matrix -- this repo has no deployment target and no OS/version variability
that matters, so CI's job is exactly "does it typecheck and pass tests on every push," nothing
more, per the same "don't build infrastructure this doesn't need" reasoning as everywhere else
in this pass.

## Type-checking & tests

```bash
npm run typecheck
npm test
```

`npm test` runs a real Vitest unit suite (303 tests across 35 files, no network/browser
needed) over the near-pure logic: checkpoint evaluation (URL templates, wildcards, text
matching, malformed-input guards), redaction (including the exact credential-leak scenario
described in `REPORT.md` "Safety", and non-string/nested-value masking), allowlist route
matching (including the origin-vs-prefix bypass cases described in `REPORT.md` "Safety"),
artifact schema cross-field validation, the confidence/registry math, the recorder's
artifact-building, the tenant-override module (patch application, and that it throws on a
stepId/strategy/known-outcome that doesn't exist rather than silently no-oping), the
UI-drift signal's extraction/aggregation logic and the confidence circuit breaker it feeds,
the dashboard's cost/time math, cross-tenant drift matrix, and HTML escaping (a deliberate
check that artifact-sourced free text can't inject markup into the rendered page), the
capability API's result-to-HTTP-status mapping and its tenant-resolution logic
(file-not-found and declared-vs-requested-tenantId mismatch, both against real temp files,
not mocks), the conversational front end's plan-extraction and credential-redaction logic,
the bounded assisted-recovery module's DOM- and vision-tool resolution and its risky-action
confirm/decline contract (using the same scripted-fake-model-output discipline as
everything model-judgment-shaped below), the replay engine's guardrail/recovery/retry
behavior (including the assisted-recovery wiring, end to end within a full `replay()` call,
not just in isolation), the multi-run stability signal's flaky/healthy/just-degraded logic,
the audit-report module's run-type inference, risky-action extraction, and markdown
escaping, and the discovery loop's own control flow (escalate/resume, dead-end detection,
risky-action confirmation) -- using a stub `Surface`, a scripted fake model *output* (not a
claim about what real Gemini would decide), and, where a class's own private state made a
stub impractical, a real `GuardrailsPolicy` against a temp config.
What's deliberately not unit-tested with mocks: the real Playwright surface, and Gemini's
actual judgment about what to click/propose -- see `REPORT.md` "Architecture" for why real
runs in `/evidence` (including `escalation-resume-demo` and its replay-side counterpart
`escalation-resume-replay-demo`, the `failure`-result replay above, the cross-tenant reuse
pair in step 6, and the assisted/vision-fallback runs in steps 12-13) are the right
verification for those instead. The escalation-resume decision logic itself
(`resolveInterventionDecision` in `src/escalation/controller.ts`) and the replay engine's
own post-escalation retry/checkpoint-recheck logic (`src/replay/replay-engine.ts`) *are*
real Vitest-covered, near-pure logic -- only the live Page/browser parts stay
evidence-verified.
