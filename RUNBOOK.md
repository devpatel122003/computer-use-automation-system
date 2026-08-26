# Demo day runbook (interface.ai onsite, 2026-08-28)

Internal rehearsal doc, not a graded deliverable. Goal: reduce the live demo to "press enter,
narrate," with a pre-decided fallback for every step that touches a live model or a live
browser — what to run, in what order, and what to do if it breaks.

**Timing below is real**, from a full clean-clone re-verification run on 2026-08-25 (fresh
`git clone` from GitHub, all 19 README demo-path steps run end to end for real, all Gemini
calls included). Verdict from that run: **GO for Friday**, once three real bugs it found are
reviewed and committed (see "Known-fixed issues" below) — one of them (an interactive-prompt
hang on closed stdin) could otherwise have caused an unexplained live freeze. Numbers below
are pure command execution time; narration will dominate actual wall-clock in the room, so
treat these as a floor, not the real beat length.

## Known-fixed issues (from the 2026-08-25 clean-clone verification, not yet committed)

1. **README.md's own demo-path replay commands** for the happy path, `member_not_found`, and
   unattended-replay steps omitted the required `accountType` param — copy-pasting them as
   written threw `Missing required input params: accountType`. Fixed in README.md and in
   this runbook's Beats 1-2 above.
2. **`src/escalation/prompt.ts` hung indefinitely** on a closed/non-interactive stdin (e.g.
   `--allow-risky true < /dev/null` hitting the confidence circuit breaker's interactive
   fallback) — with a live browser still open there was nothing to force the process to
   exit. Now declines cleanly instead. This is the one that could have caused a silent,
   unexplained freeze mid-demo if a `--allow-risky` run's confidence had degraded without
   anyone noticing.
3. **`src/cli/agent-invoke-demo.ts`** printed a factually wrong decline reason ("isn't
   approved yet") for an artifact that genuinely *was* approved but had low/drift-capped
   confidence instead — confusing if said out loud live. Now distinguishes the two cases.

All three fixes are sitting uncommitted in the working tree as of this writing (222/222
tests passing, typecheck clean) — commit them before Friday.

## The night before (2026-08-27, before the flight)

- [ ] Charge the laptop fully; bring the charger (per interface.ai's own instruction).
- [ ] Confirm `.env` has a real `GEMINI_API_KEY`, `CAPABILITY_API_KEY`, `DASHBOARD_PASSWORD`,
      and set `GEMINI_FALLBACK_MODELS` (see README "Gemini quota fallback") to at least one
      or two models beyond the primary — this is the single highest-leverage thing to do
      before traveling, since a daily-quota exhaustion with no fallback configured is the one
      failure mode that can't be fixed live without editing `.env` and restarting mid-demo.
- [ ] Check how much of today's Gemini free-tier quota is left. If it's thin, do **not** do a
      fresh `run-agent` rehearsal tonight — burning the discovery run's quota the night before
      a morning demo is the wrong trade. Rehearse the *narration* instead, against the
      already-checked-in `/evidence`.
- [ ] Confirm `git status` is clean and `main` matches `origin/main` (`git fetch && git log
      origin/main..HEAD` should be empty) — the whole point of the clean-clone verification
      was making sure what's on GitHub is what gets demoed.
- [ ] Close anything else on the laptop that might be listening on 4000/4100/4600/4700.
- [ ] Review and commit the three fixes from the 2026-08-25 clean-clone verification
      (`README.md`'s missing `accountType` params, `src/escalation/prompt.ts`'s closed-stdin
      hang, `src/cli/agent-invoke-demo.ts`'s wrong decline reason) — see the hand-off message
      for the exact commands. Don't travel with these still uncommitted.

## Morning of (before leadership walks in)

- [ ] `git pull` one more time in case anything changed.
- [ ] Open four terminal tabs/panes, labeled (mentally or literally): **T1 mock-bank**,
      **T2 mock-bank:northgate**, **T3 capability-api**, **T4 scratch** (replay/approve/etc).
- [ ] `npm run mock-bank` in T1. Confirm `http://localhost:4000` loads.
- [ ] `curl -s -X POST http://localhost:4000/__test__/reset` — start from a clean sub-account
      state so a memberId you demo against isn't already "used" from a rehearsal.
- [ ] Have `README.md` and `REPORT.md` open in an editor tab, not just memorized —
      REPORT.md's own cut-lines and "what I'd build next" are exact, quotable answers to the
      hardest follow-up questions; don't paraphrase from memory under pressure when the real
      text is one tab-switch away.
- [ ] Do **not** run a fresh `run-agent` "just to check it still works" this morning unless
      quota headroom is comfortable — that's exactly the run you want live in front of
      leadership, not spent on a last-minute nerves-check.
- [ ] `npm run drift-report` and eyeball `evidence/artifacts/registry.json` for the base
      artifact's approval state and confidence (as of 2026-08-25: `approved`, 18/21 clean
      runs, only step-11's known extract-step false-positive drifting — healthy). The
      confidence circuit breaker means a degraded score silently turns Beat 1/4's
      `--allow-risky` into an interactive prompt instead of a clean unattended pass — better
      to discover that here than mid-sentence in the room. If it's degraded, either say so
      explicitly when it prompts (it's the circuit breaker working as designed, a good story
      in its own right) or run a couple of clean replays first to rebuild it.

## The demo sequence itself

Ordered to match the brief's own evaluation-criteria priority (system design → core-loop
correctness → error handling → escalation → multi-tenant → safety), so if you run short on
time, cutting from the bottom loses the least.

### Beat 1 — Core loop, live: discovery → artifact → replay `[real: ~1-2 min discovery + ~3s replay]`

```bash
npm run run-agent
```
Narrate while it runs: observe→decide→act, one Gemini function-call per turn, the risky-write
confirmation prompt is guardrails working as designed, not a bug — type `yes`. On success,
point at the two things it just produced: the JSONL evidence log and
`evidence/artifacts/open-sub-account.artifact.json`. Open the artifact file and walk through
the schema shape (locator fallback chain, typed params, `knownOutcomes`) — this is
"Artifact schema," the brief's own stated focal point.

Then immediately replay it deterministically:
```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```
(Still `draft` at this point, so this still prompts — type `yes`. That's the point: say so.)
**`accountType` is required** — omitting it throws `Missing required input params:
accountType` instead of replaying (a real bug the 2026-08-25 clean-clone run found in this
exact command as originally written in README.md; already fixed there and here).

**If Gemini 503s or rate-limits mid-run:** the code already retries with backoff, and now
falls back across `GEMINI_FALLBACK_MODELS` on a genuine daily-quota exhaustion — narrate that
this is exactly the resilience layer REPORT.md documents, and let it ride out live if there's
time. **If it's clearly not recovering** (all fallback models exhausted too): stop, say so
plainly, and pivot to the checked-in `/evidence` from a real prior run instead — REPORT.md's
own philosophy is "we can't assess a description of it," so walking through **real** prior
evidence beats faking a live run.

### Beat 2 — The three-way replay contract: business outcome + real failure `[real: ~3s + ~8s]`

```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"40404","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```
→ `business_outcome: member_not_found`. Say explicitly: *this is a legitimate answer the
caller needs, not a crash* — the brief's own wording for "the most common design mistake
here."

```bash
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"MoneyMarket","initialDeposit":"100"}' \
  --allow-risky true
```
→ `status: failure`, with step id + expected + observed + a screenshot path. Say: *nothing in
`knownOutcomes` explains this, so it correctly refuses to guess.*

No model calls in this whole beat — good moment to say so explicitly ("replay never calls a
model; this is the path an AI agent would trigger in production, and it's fully
deterministic").

### Beat 3 — Escalation, with resume `[real: ~17s]`

```bash
npm run escalation-resume-demo
```
This is the single most differentiating beat — most systems only ever demo "abort." Narrate
the sequence as it happens: permission-denied hit → intervention raised → (scripted) human
redirects the *same live session* → discovery **re-observes**, doesn't assume state → goal
completes on the same session. Explicitly name the seam: `controller: 'automation' | 'human'`,
and that a real console would attach to the same page via its CDP endpoint without changing
this model at all.

### Beat 4 — Cross-tenant reuse, with the negative control `[real: ~5s per replay, once northgate mock-bank is up]`

```bash
npm run mock-bank:northgate    # T2, keep running
curl -s -X POST http://localhost:4100/__test__/reset
npm run replay -- --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/northgate-cu.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```
Type `yes`. Point at the rebranded copy on screen ("Log In" vs "Sign On") succeeding via a
one-line override, not a re-recording. Then, if time allows, show the negative control
failing without the override (`_negative-control-url-only.json`) — this is the proof that the
override is load-bearing, and it's a stronger beat than the success alone because it shows
honest self-skepticism, not just a demo that was set up to work.

### Beat 5 — The number that ties it to "why this matters economically" `[real: instant load]`

```bash
npm run dashboard    # T3 or T4
```
Open `localhost:4600`, HTTP Basic auth (`DASHBOARD_PASSWORD`). Point at the
discovery-vs-replay time/model-call comparison specifically — this is the single number that
answers the brief's own framing ("reliably and cheaply, without re-reasoning about the UI
every time").

### Beat 6 (only if time remains) — pick at most one or two

Agent-facing capability interface (`agent-invoke-demo`), the conversational front end
(`agent-chat`), assisted/vision-grounded fallback, multi-run stability (`canary-check`),
compliance export. Don't tour all five live — mention they exist, point at REPORT.md §8 for
depth, and only demo one if a specific question invites it (e.g. if asked "can an agent
actually call this," that's exactly when to run `agent-invoke-demo` live instead of just
describing it).

## Contingency playbook

| Symptom | Response |
|---|---|
| Gemini 429 (`RESOURCE_EXHAUSTED`, per-minute) | Code backs off and retries automatically — narrate it, let it ride (a few seconds to ~1 min). |
| Gemini 429 (`RESOURCE_EXHAUSTED`, daily quota, all fallback models also exhausted) | Stop the live call. Say so plainly. Pivot to the checked-in `/evidence` for that exact scenario and narrate from real logs/screenshots instead. |
| Headed browser window doesn't visibly appear | Confirm the process is still progressing via terminal output before assuming failure — narrate from terminal/evidence either way. |
| A port is already bound (leftover process from rehearsal) | `lsof -ti:4000,4100,4600,4700 \| xargs kill` before starting, or just use the terminal that already has it running instead of restarting. |
| A memberId/artifact state looks "already used" from a rehearsal | `curl -s -X POST http://localhost:<port>/__test__/reset` before the beat that needs a clean state. |
| A genuinely new/unexpected error appears live | Don't debug live in front of leadership. Say what you'd check first (mirrors REPORT.md's own "failure" contract: step, expected, observed), and move to the next beat or to checked-in evidence. |
| An unattended `--allow-risky` replay against a `< /dev/null`-style closed stdin (no live operator to answer) | Fixed 2026-08-25 — used to hang forever if the confidence circuit breaker fell back to an interactive prompt with no one able to answer; now declines cleanly. Confirm this fix is committed before Friday (see morning checklist). |

## If there's no offer, but a 30-minute code review with an engineer follows

Different audience, different pacing: assume they will open files, not watch a terminal. Have
`REPORT.md` §7 ("Cuts," including the adversarial-review bugs found and fixed) and §8
(stretch-goal depth) ready to navigate to directly. Lead with whichever part of the codebase
they ask about; don't re-run the demo sequence above for a single engineer who can read the
code themselves faster than watching it execute.
