# Computer-Use Automation System

[![CI](https://github.com/devpatel122003/computer-use-automation-system/actions/workflows/ci.yml/badge.svg)](https://github.com/devpatel122003/computer-use-automation-system/actions/workflows/ci.yml)

A small, real end-to-end slice of the system described in the take-home brief: an LLM drives
a live web app to accomplish a goal (**discovery**), the successful run is recorded as a
typed, versioned **capability artifact**, and that artifact **replays deterministically** —
no model involved — with structured success / business-outcome / failure results, an
allowlist-based guardrail layer, and a real (not mocked) human-escalation handoff. It also
includes five of the take-home brief's six Section 8 stretch goals (confidence & approval,
cross-tenant reuse, an agent-facing capability interface, assisted/vision-grounded fallback,
and multi-run stability) and a full adaptation to a second, live legacy target (MERIDIAN
CORE).

**This README is deliberately just setup + exact commands.** The reasoning, trade-offs, and
evidence behind every decision live in `docs/` (one topic per file — see
[`docs/README.md`](docs/README.md) for the index) and the short [`REPORT.md`](REPORT.md)
design write-up. [`SECURITY.md`](SECURITY.md) has the consolidated threat model.

**Reading guide.** If you're evaluating against either brief: this file's `## Demo path`
through step **11**, plus `## MERIDIAN CORE adaptation demo path`, is the graded core. Steps
**12–15** are the take-home's own stretch goals. Everything under **11c** describing the
unified console (target switcher, console-reachable escalation, "Register a new target") is
real and worth trying, but explicitly **beyond what either brief requires** — see `REPORT.md`
§9 and [`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md).

## What's in here

One clear job per directory; see [`docs/01-system-design.md`](docs/01-system-design.md) for
the full module map and data flow.

- `apps/mock-bank/` — the primary target app (legacy-styled, no test IDs; five flows plus
  seeded error/edge scenarios) — [`docs/25-mock-bank-target-app.md`](docs/25-mock-bank-target-app.md)
- `apps/utility-mock/` — a second, independent fixture app (different domain, used to test
  generalization to a genuinely unfamiliar UI) — [`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md)
- `src/surface/` — the `Surface` perceive/act abstraction + its Playwright implementation —
  [`docs/03-surface-abstraction.md`](docs/03-surface-abstraction.md)
- `src/agent/` — the discovery loop (observe → Gemini function-call → act) + model-retry/
  fallback — [`docs/04-discovery-agent.md`](docs/04-discovery-agent.md),
  [`docs/20-gemini-quota-and-resilience.md`](docs/20-gemini-quota-and-resilience.md)
- `src/artifact/` — the capability schema (Zod), the recorder, the confidence/approval
  registry, cross-tenant overrides — [`docs/05-artifact-schema.md`](docs/05-artifact-schema.md),
  [`docs/10-confidence-and-approval.md`](docs/10-confidence-and-approval.md),
  [`docs/11-cross-tenant-reuse.md`](docs/11-cross-tenant-reuse.md)
- `src/replay/` — the deterministic replay engine, checkpoints, UI-drift signal, the
  confidence circuit breaker, opt-in assisted recovery —
  [`docs/06-deterministic-replay.md`](docs/06-deterministic-replay.md),
  [`docs/12-ui-drift-detection.md`](docs/12-ui-drift-detection.md),
  [`docs/13-assisted-fallback-and-vision.md`](docs/13-assisted-fallback-and-vision.md)
- `src/dashboard/` — read-only ops page — [`docs/16-dashboard.md`](docs/16-dashboard.md)
- `src/api/` — the agent-facing capability API + the HTTP-native human-escalation registry —
  [`docs/14-capability-api.md`](docs/14-capability-api.md),
  [`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md)
- `src/frontend/` + `src/chat-ui/` — natural-language → capability planner, the CLI and web/
  voice chat console (multi-target, with the escalation card and "Register a new target") —
  [`docs/15-conversational-frontend.md`](docs/15-conversational-frontend.md),
  [`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md)
- `src/guardrails/` — allowlist policy, risk classification, redaction —
  [`docs/07-guardrails-and-safety.md`](docs/07-guardrails-and-safety.md)
- `src/escalation/` — the terminal-prompt pause/human-takeover/resume controller —
  [`docs/08-escalation-and-handoff.md`](docs/08-escalation-and-handoff.md)
- `src/http/` — API-key/Basic auth + structured access logging —
  [`docs/19-security-and-authentication.md`](docs/19-security-and-authentication.md)
- `src/evidence/` — the JSONL run logger + compliance/audit export —
  [`docs/09-evidence-and-logging.md`](docs/09-evidence-and-logging.md),
  [`docs/18-compliance-audit-export.md`](docs/18-compliance-audit-export.md)
- `src/cli/` — every entry point (`run-agent*`, `replay`, `approve`, `record-capability`,
  `escalation-resume-demo`, `canary-check`, ...) and each capability's domain config
- `evidence/` — real discovery/replay runs, artifacts, and registries checked in as proof
- `Dockerfile.*` + `docker-compose.yml` — containerizes the long-running services —
  [`docs/22-docker-and-containers.md`](docs/22-docker-and-containers.md)
- `.github/workflows/ci.yml` — typecheck + test + audit on every push —
  [`docs/23-continuous-integration.md`](docs/23-continuous-integration.md)
- `.env.example` — every environment variable, documented, safe to commit

## Setup

Requires Node.js >= 20.

```bash
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env              # fill in real values below (git-ignored)
```

```
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-3.7-flash
GEMINI_FALLBACK_MODELS=gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.0-flash

# Required to start the capability API and dashboard (SECURITY.md "Authentication")
CAPABILITY_API_KEY=generate-a-random-value
DASHBOARD_PASSWORD=generate-a-random-value
```

Get a Gemini key at https://ai.google.dev. Generate the other two yourself, e.g.
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Plain
`npm run replay` and `npm run mock-bank` need neither — replay never calls the model, and
mock-bank is the target app, not a secured surface.

Gemini's free-tier daily quotas are small; every real Gemini call in this repo automatically
falls back across `GEMINI_FALLBACK_MODELS` the moment the *primary* model's daily quota (not
just a per-minute rate limit) is exhausted — see
[`docs/20-gemini-quota-and-resilience.md`](docs/20-gemini-quota-and-resilience.md) if you hit
this mid-demo.

## Demo path

Everything below assumes you're in the repo root.

**Want everything running at once instead of one terminal per server?**

```bash
npm run dev-all
```

Starts mock-bank (4000), both capability-api instances (4700/4701), both dashboards
(4600/4601), and the chat-ui console (4800) together in one terminal, output prefixed by
service name. Ctrl+C stops all of them. Steps 1+ below are the same servers started
individually, useful when you want a given service's output isolated in its own terminal.

**1. Start the target app** (separate terminal, keeps running):

```bash
npm run mock-bank
# -> mock-bank listening on http://localhost:4000
```

**2. Run the discovery agent** against a real goal — launches a real headed Chromium window,
drives it with Gemini, and on success writes evidence + a capability artifact:

```bash
npm run run-agent
```

Default goal opens a sub-account for member `10001`. You'll get one terminal confirmation
prompt (opening an account is `risky`) — type `yes`. On success:
`evidence/artifacts/open-sub-account.artifact.json` is written. Flags:
`--goal "..."`, `--start-url ...`, `--headless true`, `--artifact-out path.json`. Full loop
design: [`docs/04-discovery-agent.md`](docs/04-discovery-agent.md).

**2b. A real escalation resolved with `resume`, not `abort`** — a human redirects the same
live session to a permitted member, and the goal completes afterward on that same session:

```bash
npm run escalation-resume-demo
```

Why this one, and what's scripted vs. real: [`docs/08-escalation-and-handoff.md`](docs/08-escalation-and-handoff.md).

**3. Replay the artifact** — deterministic, no LLM call:

```bash
curl -s -X POST http://localhost:4000/__test__/reset   # optional: clean slate

npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

`--allow-risky true` is only honored once the artifact is `approved` (step 5) — on a fresh
recording it's ignored and you'll be prompted interactively instead.

**4. A real error/exceptional-state replay.** Deterministic trigger IDs in
`apps/mock-bank/src/data.ts`:

| memberId | Result |
|---|---|
| `10001`, `10002` | happy path |
| `40404` (or any unseeded ID) | `business_outcome: member_not_found` |
| `99999` | `business_outcome: permission_denied` |
| `55555` | 3s simulated slow load (handled transparently) |
| `90909` | session times out **once** mid-flow, then re-authenticates and retries (`recoverable`) |
| any memberId + `initialDeposit` under `25` | `business_outcome: validation_error` |

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"40404","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

Full three-way contract and every edge case: [`docs/06-deterministic-replay.md`](docs/06-deterministic-replay.md).

**4b. A real (not simulated) `failure` result** — an `accountType` the app's dropdown doesn't
actually offer:

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"MoneyMarket","initialDeposit":"100"}' \
  --allow-risky true
```

**4c. Resuming a REPLAY hard failure**, not just discovery's — member `77777` triggers an
unexpected interstitial the recorded artifact never accounted for:

```bash
curl -s -X POST http://localhost:4000/__test__/reset
npm run escalation-resume-replay-demo
```

Also available as a plain flag for any artifact: `--interactive-escalation true`. Why two
paths, and what's scripted vs. real: [`docs/08-escalation-and-handoff.md`](docs/08-escalation-and-handoff.md).

**4d. The same handoff, reachable from the console** — no terminal, no scripted click:

```bash
npm run capability-api    # headed by default
npm run chat-ui
```

Open `http://localhost:4800`, ask *"Open a savings account for member 77777 with $50"*,
confirm with "yes". A red intervention card shows a live screenshot + Resume/Abort while a
real headed Chromium window sits on the interstitial — click through it for real, then click
Resume. Full mechanism and what's verified:
[`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md).

**5. Confidence & approval (stretch goal).** A fresh artifact starts `draft`, where
`--allow-risky` is ignored. Build history, then approve:

```bash
npm run approve -- --artifact evidence/artifacts/open-sub-account.artifact.json
```

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true < /dev/null   # now fully unattended
```

Fingerprint-keyed (not just id+version), so a materially different re-recording starts back
at `draft`. `--revoke true` sends one back manually. Full design:
[`docs/10-confidence-and-approval.md`](docs/10-confidence-and-approval.md).

**6. Cross-tenant reuse (stretch goal)** — the same artifact, replayed against a second,
rebranded tenant via a small named override, no re-recording:

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

Type `yes` at the prompt. Full design, including the negative-control proof the override is
load-bearing: [`docs/11-cross-tenant-reuse.md`](docs/11-cross-tenant-reuse.md).

**7. UI-drift signal** — diffs each replay's matched locator strategy against what was
recorded:

```bash
npm run drift-report
```

**7b. Self-healing locator proposals** — generates an override's *shape* (never a value you
didn't review) from the drift signal above:

```bash
npm run propose-override -- --tenant-id northgate-cu-url-only-negative-control
```

Both: [`docs/12-ui-drift-detection.md`](docs/12-ui-drift-detection.md).

**8. Capability dashboard** — contract, approval/confidence, drift, and a discovery-vs-replay
comparison in one page:

```bash
npm run dashboard
# -> http://localhost:4600 (HTTP Basic auth: operator / your DASHBOARD_PASSWORD)
```

[`docs/16-dashboard.md`](docs/16-dashboard.md).

**9. Agent-facing capability interface (stretch goal)** — an HTTP surface an AI agent could
discover and invoke by name with typed args:

```bash
npm run capability-api
# -> http://localhost:4700

npm run agent-invoke-demo -- --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```

Takes an optional `tenantId` too (applies a step-6 override before replaying — see
[`docs/14-capability-api.md`](docs/14-capability-api.md) for the full contract and tenant-aware
invocation example).

**10. Confidence circuit breaker** — an `approved` artifact whose drift-adjusted confidence
has degraded still falls back to attended confirmation, regardless of `--allow-risky`:
[`docs/10-confidence-and-approval.md`](docs/10-confidence-and-approval.md).

**10b–10e. Four more independently-recorded capabilities**, proving the system generalizes
past the first one — `create-member`, `check-balance` (read-only; extracts member name and a
sub-accounts summary too, not just balances), `transfer-funds` (`insufficient_funds`/
`invalid_transfer`), and `close-sub-account` (`already_closed`, `no_sub_account_to_close`):

```bash
npm run run-agent-create-member       # then: npm run replay -- --artifact evidence/artifacts/create-member.artifact.json --params '{"username":"demo_operator","password":"demo_password","fullName":"Priya Nair","initialChecking":"1000","initialSavings":"250"}' --allow-risky true
npm run run-agent-check-balance       # then: npm run replay -- --artifact evidence/artifacts/check-balance.artifact.json --params '{"username":"demo_operator","password":"demo_password","memberId":"10001"}'
npm run run-agent-transfer-funds      # then: npm run replay -- --artifact evidence/artifacts/transfer-funds.artifact.json --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","fromAccount":"Checking","toAccount":"Savings","amount":"100"}' --allow-risky true
npm run run-agent-close-sub-account   # then: npm run replay -- --artifact evidence/artifacts/close-sub-account.artifact.json --params '{"username":"demo_operator","password":"demo_password","memberId":"10002"}' --allow-risky true
```

Real gaps found and fixed while building these (the hidden-Close-link bug, the
position-based-locator limit, the under-extracting check-balance):
[`docs/25-mock-bank-target-app.md`](docs/25-mock-bank-target-app.md).

**10f. Recording a new capability from one config file, no new source file:**

```bash
npm run record-capability -- --config config/capability-configs/mock-bank-check-balance.example.json
```

Still requires hand-authored `paramMappings`/`successCheckpoint`/`knownOutcomes` (that stays
human, on purpose — see `REPORT.md` §7) — this only removes the need for a new `.ts` wrapper
file to hold them. See the two example configs for the field-by-field shape.

**11. Conversational front end** — natural language mapped to a capability + typed args by
one Gemini call:

```bash
npm run agent-chat -- --message "Using operator demo_operator and password demo_password, open a savings account for member 10001 with a starting deposit of 100 dollars"
```

**11b. The same front end as a real chat (+ voice) web UI:**

```bash
npm run mock-bank && npm run capability-api && npm run chat-ui   # each if not already running
```

Open `http://localhost:4800`. Confirms before anything risky; supports chained requests
("create a member, then open an account for them"). Design + real bugs found:
[`docs/15-conversational-frontend.md`](docs/15-conversational-frontend.md).

**11c. The unified, multi-target console** — one page/port, a target switcher (Mock Bank /
MERIDIAN teller / MERIDIAN supervisor), a live capability catalog, per-target demo-script
buttons, the console-reachable escalation card (4d), and "Register a new target." **Real, and
worth trying — explicitly beyond what either brief requires.** Full write-up:
[`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md).

**12. Assisted fallback (stretch goal)** — one bounded, policy-checked LLM recovery per
failed step, opt-in only:

```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/_negative-control-url-only.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}' \
  --assisted-recovery true
```

**13. Vision-grounded fallback** — a canvas-only fixture with no DOM semantics at all:

```bash
npm run vision-fallback-demo
```

Both: [`docs/13-assisted-fallback-and-vision.md`](docs/13-assisted-fallback-and-vision.md).

**14. Multi-run stability (stretch goal)** — a real, unattended canary replay + health
read-out, meant for a schedule:

```bash
npm run canary-check -- --headless true
```

[`docs/17-multi-run-stability.md`](docs/17-multi-run-stability.md).

**15. Compliance/audit export** — turns existing redacted evidence into a compliance report:

```bash
npm run compliance-report -- --out compliance-report.md
```

[`docs/18-compliance-audit-export.md`](docs/18-compliance-audit-export.md).

## MERIDIAN CORE adaptation demo path

Points the exact same core at a real, live, hosted legacy target — MERIDIAN CORE, a
credit-union servicing console at `https://web-sample.interface-hiring.com` — with no code
changes beyond what's named in [`ADAPTATION.md`](ADAPTATION.md) (read that first). No local
app to start; six capabilities are recorded and approved under `evidence/artifacts-meridian/`:

| Capability | Kind |
|---|---|
| `meridian-check-balance` | read |
| `meridian-member-search` | read, by number or last name |
| `meridian-transfer-funds` | write, review→post, irreversible — **minimum-bar #2** |
| `meridian-open-share` | write, review→post |
| `meridian-update-member` | write, single direct POST |
| `meridian-place-hold` | write, review→post, supervisor-gated |

Replay one (note the `--registry` flag — it defaults to the mock-bank one otherwise):

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-check-balance.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100234"}'
```

A clean exceptional state, live — a teller attempting the supervisor-only Place Hold:

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-place-hold.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"102777","shareId":"102777-S0001","reasonCode":"LEGAL","notes":""}' \
  --allow-risky true
# -> business_outcome / supervisor_override_required, a real 403 from the live app
```

Injected faults: `?inject=<kind>` on a URL you drive manually, or globally via the live app's
own `/settings` screen (`errorRate`/`forcedInject` — reset `forcedInject` to `""` afterward,
it's global and shared).

**Capability API, dashboard, and the console, pointed at MERIDIAN:**

```bash
npm run capability-api-meridian   # port 4701
npm run dashboard-meridian        # port 4601
npm run chat-ui                   # port 4800 -- one console, every target
```

Open `http://localhost:4800`, click **"MERIDIAN CORE (teller)"** in the target switcher.
Click **"MERIDIAN CORE (supervisor)"** and ask the same Place Hold question again — same
backend, same catalog, only the identity changed, and it actually posts. Full console design:
[`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md).

**The escalation demo** — force a session-timeout mid-flow at a write capability's risky
`/post` step (via the live app's `/settings`), watch it fall through to a real
`requestIntervention` prompt instead of a silent retry or a hang:

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-transfer-funds.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100987","fromShare":"100987-S0001","toShare":"100987-MMKT-3","amount":"1.00"}' \
  --interactive-escalation true
```

Type `yes`, then in a second terminal set `/settings`' Force error to `timeout` before
answering the intervention prompt. Real evidence: `evidence/runs/replay-2026-08-27T01-08-57-002Z/`
(see `ADAPTATION.md`). Reset `forcedInject` to `""` afterward.

## Running without live services

Plain `npm run replay` needs mock-bank running but never calls Gemini. Steps 11–13 (chat,
assisted fallback, vision fallback) do call Gemini, same as discovery — no way to demo those
without a real model call, by design. Steps 14–15 (canary, compliance) never call Gemini.

## Running via Docker Compose

Containerizes mock-bank (both tenants), the capability API, and the dashboard. The
interactive headed-browser demos (steps 2, 2b, 4c, 12, 13) stay host-only — they can't run
headless in a container.

```bash
cp .env.example .env   # fill in real values first
docker compose up --build
```

Same ports as running natively (4000/4100/4700/4600). **Not build-tested** (Docker wasn't
available in the environment that produced these files) — reviewed for correctness, not
verified end-to-end. Full detail: [`docs/22-docker-and-containers.md`](docs/22-docker-and-containers.md).

## Continuous integration

`.github/workflows/ci.yml`: typecheck, the unit suite, and a dependency-audit gate on every
push to `main`. One job, no deploy stage. [`docs/23-continuous-integration.md`](docs/23-continuous-integration.md).

## Type-checking & tests

```bash
npm run typecheck
npm test
```

A real Vitest unit suite over the near-pure logic (checkpoints, redaction, allowlist
matching, schema validation, the confidence/registry math, the replay engine's recovery/
retry/escalation state machine, the discovery loop's own control flow, and more) — using a
stub `Surface` and scripted fake model *outputs*, never a claim about what real Gemini would
decide. What's deliberately not mock-tested: the real Playwright surface and Gemini's actual
judgment — those are verified by the real runs in `/evidence` instead. Full coverage list and
rationale: [`docs/21-testing-strategy.md`](docs/21-testing-strategy.md).
