# Demo day runbook (interface.ai onsite, 2026-08-28)

Internal rehearsal doc, not a graded deliverable. Covers **two demos** the brief asks to show
together: Part 1 is the original take-home system against `mock-bank`; Part 2 is the later
Adaptation Project, the same core pointed at a real, live external target (MERIDIAN CORE).
Goal for both: reduce the live demo to "press enter, narrate," with a pre-decided fallback for
every step that touches a live model, a live browser, or (for Part 2) a live network
dependency this laptop doesn't control — what to run, in what order, and what to do if it
breaks.

**Part 1 timing is real**, from a full clean-clone re-verification run on 2026-08-25 (fresh
`git clone` from GitHub, all 19 README demo-path steps run end to end for real, all Gemini
calls included) — verdict from that run was **GO**, and the real bugs it found (see
"Known-fixed issues" below) are committed. **Part 2 timing is real too**, from this session's
own live runs against `web-sample.interface-hiring.com` (real replay/discovery output, not
estimated). Numbers below are pure command execution time; narration will dominate actual
wall-clock in the room, so treat these as a floor, not the real beat length.

## Known-fixed issues (from the 2026-08-25 clean-clone verification — all committed)

Historical record, kept for context on why certain beats below are worded the way they are.
All four of these are long since committed (`33906b6`, `9616255`) — nothing to do here before
Friday beyond the checklist below.

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
4. **`src/escalation/controller.ts`'s `requestIntervention()` could not tell "no one was
   there to answer" apart from "a human deliberately pressed Enter to resume"** — both
   collapsed to the same empty string after fix #2 above, so a closed-stdin escalation would
   have silently resumed instead of aborting. Found while building replay's own
   escalation-resume (see below); fixed by having `promptLine` return `null` specifically for
   stream closure, distinct from a real blank answer.

**Replay-side escalation-resume.** Discovery already had real mid-run resume; replay (the
brief's own "production execution path") didn't — a hard failure just ended the run.
`ReplayOptions.onEscalate` closes that gap: a genuine hard failure now offers a human one
bounded chance to fix live state and resume, opt-in via `--interactive-escalation true` (same
posture as `--assisted-recovery`). See Beat 3b below and REPORT.md §5/§7 for the full design
and the bug found while building it (#4 above).

**Since then: the Adaptation Project.** A later, separate brief (issued 2026-08-26) asks for
this same core to be pointed at a real, live legacy target — MERIDIAN CORE, at
`web-sample.interface-hiring.com` — and demoed live *alongside* the take-home system above,
per the brief's own words. That's a second half of Friday's demo, not a replacement for the
first; see Part 2 below. Full write-up in `ADAPTATION.md`. As of this pass: **303 tests
passing across 35 files**, typecheck clean (numbers above are historical, from the earlier,
smaller take-home-only suite).

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
- [ ] **For Part 2:** confirm `https://web-sample.interface-hiring.com` is actually reachable
      from whatever network you'll demo on. This is a real risk, not a theoretical one — a
      corporate/network content filter blocked this exact domain once during this project's
      own build ("Web Page Blocked... Category: high-risk"), and it needed a human to
      explicitly unblock it before any MERIDIAN work could proceed. Check this from the venue's
      actual network if at all possible, not just from wherever you built this.
- [ ] Review and commit the three fixes from the 2026-08-25 clean-clone verification
      (`README.md`'s missing `accountType` params, `src/escalation/prompt.ts`'s closed-stdin
      hang, `src/cli/agent-invoke-demo.ts`'s wrong decline reason) — see the hand-off message
      for the exact commands. Don't travel with these still uncommitted.

## Morning of (before leadership walks in)

- [ ] `git pull` one more time in case anything changed.
- [ ] Open terminal tabs/panes, labeled (mentally or literally): **T1 mock-bank**,
      **T2 mock-bank:northgate**, **T3 capability-api**, **T4 scratch** (replay/approve/etc),
      **T5 MERIDIAN capability-api/dashboard/chat-ui** (Part 2, below).
- [ ] `npm run mock-bank` in T1. Confirm `http://localhost:4000` loads.
- [ ] `curl -s -X POST http://localhost:4000/__test__/reset` — start from a clean sub-account
      state so a memberId you demo against isn't already "used" from a rehearsal.
- [ ] MERIDIAN's own equivalent of a "reset": open `https://web-sample.interface-hiring.com/settings`
      (sign on as `teller1`/`password` first) and confirm **Force error** shows no selection
      and **Error rate** is `0`. This is a *shared, live, public demo target* — if anyone
      (including a rehearsal the night before) left fault injection turned on, every capability
      will look broken until it's reset. Check this last, right before going in, not just
      once during rehearsal.
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

## Part 1 — The take-home system (mock-bank)

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

### Beat 3b — The same resume story, on the REPLAY path this time `[real: ~5-10s]`

```bash
curl -s -X POST http://localhost:4000/__test__/reset
npm run escalation-resume-replay-demo
```
Say explicitly what this closes: Beat 3 showed *discovery* resuming; until this pass, *replay*
— the brief's own "production execution path," the one an AI agent triggers unattended — had
no equivalent, so a hard failure just ended the run. Member `77777` hits an unexpected
confirmation interstitial (the brief's own named runtime condition, Section 1) the recorded
artifact never accounted for. Narrate: hard failure at step-10 (nothing in `knownOutcomes`
explains it) → escalation raised → (scripted) human dismisses the interstitial on the *same*
session → replay's post-resume checkpoint recheck picks it up → real confirmation number,
without re-doing any step the human already handled by hand. If asked how this differs from
`--assisted-recovery`: that's a bounded *model* call proposing a fix; this is a bounded
*human* decision — the two are deliberately separate mechanisms for two different kinds of
"replay can't figure this out alone."

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

## Part 2 — MERIDIAN CORE (the Adaptation Project)

The later brief is explicit: demo this live, *alongside* the take-home system above, not
instead of it. Full command reference in README.md's "MERIDIAN CORE adaptation demo path";
full write-up in `ADAPTATION.md`. No local app to start — the target is already live at
`https://web-sample.interface-hiring.com`, shared and public, so **check `/settings` is reset
right before going in** (see "Morning of," above) — a stray fault injection left on from
rehearsal will make every beat below look broken.

### Beat M1 — Real success against a real, live target `[real: ~3-5s per replay]`

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-check-balance.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100234"}'
```
Say explicitly: this is not `mock-bank` — it's a real, hosted, server-rendered app
(`web-sample.interface-hiring.com`) with no test IDs and a per-transaction hidden token,
adapted with config plus six new capability recordings, not a rewrite (name the one real
core exception: the accessible-name/drift bug in `dom-scan.ts`, see `ADAPTATION.md`'s "the
one real, non-config fix" — this is the honest answer to "where wasn't it clean").

### Beat M2 — Real success, irreversible action, confirmed first `[real: ~5-8s]`

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-transfer-funds.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100987","fromShare":"100987-S0001-13","toShare":"100987-MMKT-14","amount":"5.00"}' \
  --allow-risky true
```
Point at the real confirmation number (`CN######`) that comes back — this is the brief's own
minimum-bar #2 (transfer money), completing end to end against the live target's real
review→post confirmation flow and per-transaction token.

### Beat M3 — A clean exceptional state: a teller attempting a supervisor-only action `[real: ~5s]`

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-place-hold.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"102777","shareId":"102777-S0001","reasonCode":"LEGAL","notes":""}' \
  --allow-risky true
```
→ `status: "business_outcome"`, `outcome: "supervisor_override_required"` — a real 403 from
the live app itself, not a guardrail block. Say explicitly: this is the target's own real
authorization decision, reported cleanly, exactly the brief's "at least one run that hits an
exceptional state" ask.

### Beat M4 — A real escalation: a session dying mid-flow `[real: ~15-20s]`

The single most differentiating beat in Part 2, mirroring Beat 3's role in Part 1 — most
systems only ever demo the happy path plus maybe one clean error; this shows a genuinely
undetected failure mode reaching a real human decision point.

```bash
npm run replay -- \
  --artifact evidence/artifacts-meridian/meridian-transfer-funds.artifact.json \
  --registry evidence/artifacts-meridian/registry.json \
  --params '{"username":"teller1","password":"password","branch":"MAIN-001","memberId":"100987","fromShare":"100987-S0001-13","toShare":"100987-MMKT-14","amount":"1.00"}' \
  --interactive-escalation true
```
Type `yes` at the risky-action prompt. In a **second** terminal, right after — before
answering the "HUMAN INTERVENTION REQUESTED" prompt that follows — sign on to
`https://web-sample.interface-hiring.com/settings` and set **Force error** to `timeout`,
Apply. Narrate while it resolves: the transfer capability deliberately has no
`session_timeout` recovery (a mid-flow session death means the in-progress `_token`/page
context is gone — retrying could resubmit a stale financial transaction), so this correctly
falls through to the generic hard-failure path, which calls the real escalation controller.
A genuine screenshot-backed intervention record gets written for real. The only safe answer
is `abort` — say so, and say why (nothing left to resume). **Reset `/settings`' Force error
back to blank immediately after** — it's global and affects the shared demo target for
everyone. Real evidence from exactly this sequence, if asked for a backup:
`evidence/runs/replay-2026-08-27T01-08-57-002Z/`.

### Beat M5 (only if time remains) — the chatbot and dashboard, live

```bash
CAPABILITY_ARTIFACTS_DIR=evidence/artifacts-meridian CAPABILITY_API_PORT=4701 npm run capability-api   # T5
CAPABILITY_ARTIFACTS_DIR=evidence/artifacts-meridian DASHBOARD_PORT=4601 npm run dashboard              # T5
CHAT_UI_OPERATOR_BRANCH=MAIN-001 CAPABILITY_API_BASE=http://localhost:4701 CHAT_UI_PORT=4801 npm run chat-ui  # T5
```
Open `localhost:4801`, ask it *"what's the balance for member 100234"* — same
confirm-before-risky-action flow as the take-home's own chat UI (Part 1), just talking to a
second capability-api instance pointed at MERIDIAN's catalog instead of mock-bank's, mirroring
the existing `northgate-cu` multi-tenant pattern rather than a merged, ambiguous catalog. Open
`localhost:4601` (same `DASHBOARD_PASSWORD`) to show all six MERIDIAN capabilities' approval
state and confidence in one place.

## Contingency playbook

| Symptom | Response |
|---|---|
| Gemini 429 (`RESOURCE_EXHAUSTED`, per-minute) | Code backs off and retries automatically — narrate it, let it ride (a few seconds to ~1 min). |
| Gemini 429 (`RESOURCE_EXHAUSTED`, daily quota, all fallback models also exhausted) | Stop the live call. Say so plainly. Pivot to the checked-in `/evidence` for that exact scenario and narrate from real logs/screenshots instead. |
| Headed browser window doesn't visibly appear | Confirm the process is still progressing via terminal output before assuming failure — narrate from terminal/evidence either way. |
| A port is already bound (leftover process from rehearsal) | `lsof -ti:4000,4100,4600,4700 \| xargs kill` before starting, or just use the terminal that already has it running instead of restarting. |
| A memberId/artifact state looks "already used" from a rehearsal | `curl -s -X POST http://localhost:<port>/__test__/reset` before the beat that needs a clean state. |
| A genuinely new/unexpected error appears live | Don't debug live in front of leadership. Say what you'd check first (mirrors REPORT.md's own "failure" contract: step, expected, observed), and move to the next beat or to checked-in evidence. |
| An unattended `--allow-risky` replay against a `< /dev/null`-style closed stdin (no live operator to answer) | Fixed 2026-08-25 (`33906b6`) — used to hang forever if the confidence circuit breaker fell back to an interactive prompt with no one able to answer; now declines cleanly. |
| A MERIDIAN beat (Part 2) gets an unexpected 400/403/404/440/500/503 with no narration prepared for it | Sign on to `https://web-sample.interface-hiring.com/settings` and check **Force error** — someone (a rehearsal, another candidate, a stray browser tab) may have left global fault injection on. If it's genuinely unset and this is a real natural error, that's still a legitimate business/recoverable outcome — narrate it the same way as Beat 2/M3, don't treat it as a crash. |
| MERIDIAN feels slow or the connection drops mid-beat | It's a real, live, externally-hosted target, not localhost — narrate that explicitly (this is the actual risk the brief itself calls out: "the network will not be your friend under pressure") and pivot to the checked-in evidence for that exact beat (each Beat M1-M4 command above has a real prior run under `evidence/runs/`) rather than retrying repeatedly live. |
| Two rehearsals in a row leave MERIDIAN's seed data (share balances/holds) visibly different from what a beat's narration assumes | The target is stateful in memory and resets only on redeploy, not on a schedule — pick a share/member combination you just verified is in the right state (open, not on hold) rather than trusting an older rehearsal's numbers; the beats above already use member/share pairs re-verified live during this pass. |

## If there's no offer, but a 30-minute code review with an engineer follows

Different audience, different pacing: assume they will open files, not watch a terminal. Have
`REPORT.md` §7 ("Cuts," including the adversarial-review bugs found and fixed) and §8
(stretch-goal depth) ready to navigate to directly for the take-home system, and
`ADAPTATION.md` (all five sections: what adapting took, the API shape, error handling,
safety/evidence/escalation survival, what was cut) ready for the MERIDIAN half. Lead with
whichever part of the codebase they ask about; don't re-run the demo sequence above for a
single engineer who can read the code themselves faster than watching it execute.
