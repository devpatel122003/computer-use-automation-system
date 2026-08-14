# Computer-Use Automation System

A small, real end-to-end slice of the system described in the take-home brief: an LLM
drives a live web app to accomplish a goal (**discovery**), the successful run is recorded
as a typed, versioned **capability artifact**, and that artifact **replays deterministically**
— no model involved — with structured success / business-outcome / failure results, an
allowlist-based guardrail layer, and a real (not mocked) human-escalation handoff.

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
- `src/artifact/` — the capability artifact schema (Zod) and the recorder that builds one
  from a finished discovery run.
- `src/replay/` — the deterministic replay engine and checkpoint/known-outcome evaluator.
- `src/guardrails/` — the allowlist policy, risk classification, and redaction utilities.
- `src/escalation/` — the intervention/handoff controller (pause automation, let a human
  drive the same live browser session, capture what they did, hand control back).
- `src/evidence/` — the structured JSONL run logger.
- `src/cli/` — the two entry points (`run-agent`, `replay`) and the `open-sub-account`
  capability's domain config (param mappings, checkpoints, known outcomes).
- `evidence/` — a real discovery run, a real artifact, and three real replay runs
  (success, a recovered session-timeout, and a "member not found" business outcome).

## Setup

Requires Node.js >= 20.

```bash
npm install
npx playwright install chromium   # one-time browser download
```

Create a `.env` file in the repo root (never committed) with your own Gemini API key:

```
GEMINI_API_KEY=your-key-here
# optional -- defaults to gemini-3.7-flash, which is agentic-workflow-tuned and has a
# workable free-tier quota. gemini-3.1-pro / gemini-2.5-pro's free tier is often capped
# at 0-20 requests/day, which a ~10-step discovery run can exceed; gemini-2.5-flash is a
# good fallback if you hit a quota wall on the default.
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
same as discovery.

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

## Running without live services

The mock-bank app *is* the "live service" here -- there's no external dependency beyond
it and (for discovery only) the Gemini API. `npm run replay` needs mock-bank running but
never calls Gemini. There's no way to demo the discovery step without a real model call --
per the assignment brief, that's intentional; the discovery run has to be real.

## Type-checking

```bash
npm run typecheck
```
