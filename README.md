# Computer-Use Automation System

A small, real end-to-end slice of the system described in the take-home brief: an LLM
drives a live web app to accomplish a goal (**discovery**), the successful run is recorded
as a typed, versioned **capability artifact**, and that artifact **replays deterministically**
— no model involved — with structured success / business-outcome / failure results, an
allowlist-based guardrail layer, and a real (not mocked) human-escalation handoff. It also
includes one Section 8 stretch goal: **confidence scoring + a draft→approved approval gate**
on unattended replay.

See [`REPORT.md`](REPORT.md) for the design write-up (architecture, artifact schema,
determinism & error handling, heterogeneity/multi-tenant story, escalation model, safety,
and cuts).

## What's in here

- `apps/mock-bank/` — the target application: a small, deliberately legacy-styled
  (server-rendered, table layout, no test IDs) banking back-office app with a
  member-search → member-detail → open-sub-account flow, plus seeded scenarios for
  not-found / permission-denied / validation-error / session-timeout / slow-load.
- `src/surface/` — the `Surface` abstraction (observe/act) and its Playwright implementation.
- `src/agent/` — the discovery loop: observe → Gemini function-call decision → act.
- `src/artifact/` — the capability artifact schema (Zod), the recorder that builds one from
  a finished discovery run, and the confidence/approval registry (stretch goal).
- `src/replay/` — the deterministic replay engine and checkpoint/known-outcome evaluator.
- `src/guardrails/` — the allowlist policy, risk classification, and redaction utilities.
- `src/escalation/` — the intervention/handoff controller (pause automation, let a human
  drive the same live browser session, capture what they did, hand control back).
- `src/evidence/` — the structured JSONL run logger.
- `src/cli/` — the entry points (`run-agent`, `replay`, `approve`, `escalation-resume-demo`)
  and the `open-sub-account` capability's domain config (param mappings, checkpoints, known
  outcomes).
- `evidence/` — three real discovery runs (a clean success; an escalation resolved with
  `abort` against a nonexistent member, with a real intervention screenshot/log; and an
  escalation resolved with `resume` against a permission-denied member, where the run
  continues on the same live session and actually completes the goal afterward), a real
  artifact, its confidence/approval registry, and real replay runs covering success, a
  recovered session-timeout, "member not found," "permission denied," a validation error,
  simulated slow load, the draft→approved gating flow, and a genuine `failure` result (an
  account type the app's dropdown doesn't offer, with no known outcome to explain it).

## Setup

Requires Node.js >= 20.

```bash
npm install
npx playwright install chromium   # one-time browser download
```

Create a `.env` file in the repo root (never committed) with your own Gemini API key:

```
GEMINI_API_KEY=your-key-here
# optional -- defaults to gemini-3.7-flash. Free-tier daily quotas on Gemini's flash models
# are small (single digits to low tens of requests/day) and a ~10-step discovery run can
# exhaust one in a single attempt; the code retries 429s with backoff, but once a model's
# whole daily quota is gone, no amount of retrying helps. If you see RESOURCE_EXHAUSTED,
# switch GEMINI_MODEL to a different Gemini flash-tier model and try again -- the evidence
# in this repo was itself produced on gemini-3.5-flash-lite after several other models hit
# their daily cap during testing.
GEMINI_MODEL=gemini-3.7-flash
```

Get a key at https://ai.google.dev. Nothing else needs a key -- replay never calls the model.

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
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","initialDeposit":"100"}' \
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
  --params '{"username":"demo_operator","password":"demo_password","memberId":"40404","initialDeposit":"100"}' \
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
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","initialDeposit":"100"}' \
  --allow-risky true < /dev/null
```

The registry is keyed by a content fingerprint (a hash of the artifact's steps/params/
outputs/checkpoints, excluding cosmetic fields like `createdAt`), not just `id`+`version` —
so a re-recorded artifact with materially different steps starts back at `draft`/`unproven`
automatically, rather than silently inheriting an approval it never earned. Use
`npm run approve -- --artifact <path> --revoke true` to send an artifact back to draft.

## Running without live services

The mock-bank app *is* the "live service" here -- there's no external dependency beyond
it and (for discovery only) the Gemini API. `npm run replay` needs mock-bank running but
never calls Gemini. There's no way to demo the discovery step without a real model call --
per the assignment brief, that's intentional; the discovery run has to be real.

## Type-checking & tests

```bash
npm run typecheck
npm test
```

`npm test` runs a real Vitest unit suite (89 tests across 9 files, no network/browser
needed) over the near-pure logic: checkpoint evaluation (URL templates, wildcards, text
matching, malformed-input guards), redaction (including the exact credential-leak scenario
described in `REPORT.md` "Safety", and non-string/nested-value masking), allowlist route
matching (including the origin-vs-prefix bypass cases described in `REPORT.md` "Safety"),
artifact schema cross-field validation, the confidence/registry math, the recorder's
artifact-building, the replay engine's guardrail/recovery/retry behavior, and the discovery
loop's own control flow (escalate/resume, dead-end detection, risky-action confirmation) --
using a stub `Surface`, a scripted fake model *output* (not a claim about what real Gemini
would decide), and, where a class's own private state made a stub impractical, a real
`GuardrailsPolicy` against a temp config. What's deliberately not unit-tested with mocks:
the real Playwright surface, and Gemini's actual judgment about what to click next -- see
`REPORT.md` "Architecture" for why real runs in `/evidence` (including `escalation-resume-
demo` and the `failure`-result replay above) are the right verification for those instead.
