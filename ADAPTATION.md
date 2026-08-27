# Adaptation write-up: MERIDIAN CORE

## What adapting actually took

The core (discovery loop, replay engine, artifact schema, guardrails, evidence, escalation,
capability API, dashboard) was already goal/config/artifact-driven — confirmed by reading
every touchpoint before writing anything. Nothing was hardcoded to mock-bank except literal
default *values* in specific CLI scripts. Adapting was config + six new capability
recordings for almost the whole surface, plus three small, disclosed core touches and one
genuine core bug:

1. **`src/api/server.ts` / `src/dashboard/server.ts`**: `ARTIFACTS_DIR`/`REGISTRY_PATH` were
   literal constants; made them read `CAPABILITY_ARTIFACTS_DIR`, mirroring the
   `CAPABILITY_API_PORT` pattern already in use. Lets a second capability-api and dashboard
   instance serve MERIDIAN's catalog on a separate port — same shape as the existing
   `northgate-cu` multi-tenant precedent, not a new mechanism.
2. **`src/chat-ui/server.ts`**: MERIDIAN's sign-on needs a third field (`branch`); added
   `CHAT_UI_OPERATOR_BRANCH`.
3. **`src/surface/playwright-surface.ts`**: a `page.on("response")` listener records the
   last navigation's HTTP status onto `ActionResult` as evidence — the one place the
   brief's disclosed error taxonomy (400/403/404/440/500/503) touches the core, and
   deliberately *only* as supplementary evidence, never for outcome classification (§3).

**The one real, non-config fix**: `src/surface/dom-scan.ts`'s `labelForInput()` falls back
to an element's raw HTML `name` attribute when no `<label>` exists — MERIDIAN has none at
all. That attribute is never part of a real accessible-name computation, so a `role`-strategy
locator built from it can *never* resolve via Playwright's `getByRole()`. Every typed/selected
field permanently fell back to `css_structural`, which `drift-report` correctly flagged as
drift forever, capping confidence at `low` forever and silently blocking every risky
MERIDIAN action from executing via chat/API (`effectiveAllowRisky` requires
`medium`/`high`). Root-caused from `drift-report`'s own output (100% fallback on every
`type`/`select_option` step, 0% on `click`); fixed with a ~15-line scoped change: tag
fallback-sourced names, skip the unresolvable `role`/`text` candidates for them, promote
`css_structural` to `medium` confidence when it's the only strategy that could ever work.
A real gap in the original core — a heuristic that degrades silently and permanently on
markup with no accessible names — not a rewrite. Verified by re-recording after the fix:
drift dropped to zero, and a previously-failing chat-driven transfer succeeded for real.

Everything else was config: 14 new routes in `config/allowlist.json` (MERIDIAN's real base
URL plus every path confirmed by live recon, each independently marked safe/risky), and six
files under `src/cli/capabilities/*.ts` in the exact shape mock-bank's capabilities already
use. `discovery-agent.ts`, `replay-engine.ts`, `artifact/schema.ts`, `artifact/recorder.ts`
were not touched.

## Capability API shape

Unchanged contract: `GET /capabilities` returns the catalog (id, name, version, approval
state, drift-adjusted confidence, typed `inputParams`/`outputSchema`, `hasRiskyStep`). `POST
/capabilities/:id/invoke` takes `{ params, allowRisky, tenantId? }` and returns `status`
(`success`/`business_outcome`/`recoverable`/`failure`/`escalated`) plus typed `outputs` or an
`outcome` name/description. Every invocation runs the same deterministic replay a human's
`npm run replay` does — no looser code path for agent calls — and `allowRisky` is honored
server-side under the identical approved+confidence gate the CLI uses.

MERIDIAN gets its **own** capability-api/chat-ui instance rather than a merged catalog with
mock-bank's — same server code, separate `CAPABILITY_ARTIFACTS_DIR`/port/API key. A merged
catalog risks real ambiguity ("member 100234" could be either app's member) with no way for
the model to disambiguate; a second instance costs one env var, not new code.

## Driving the legacy UI / exceptional-state handling

The per-transaction hidden `_token` needed no special handling — replay drives a real
browser through the real form every run, so the token is always read fresh, never parsed by
hand. Review→post (Transfer, Open Share, Place Hold) is just two sequential replay steps
with checkpoints between — no new engine concept. Update Member Information's genuinely
different shape (a direct `POST`, no review step, confirmed live) fell out of the same
schema with one fewer checkpoint; nothing assumed review was mandatory.

All six injectable faults (`validation`/`notfound`/`permission`/`timeout`/`maintenance`/
`server`) plus natural errors (bad login, overdraw, hold-blocked debit, invalid email,
non-supervisor hold, member-not-found being a different HTTP shape by route vs. by search)
are classified by the existing three-category `KnownOutcome` model — `business_outcome`,
`recoverable` (`retry_step` for `maintenance`/`server`; `reauthenticate_and_retry_step` for
`session_timeout`, **read capabilities only**), and the generic hard-failure path. No new
`Checkpoint` kind was needed — `text_match` against each error page's unique real copy
cleanly separated every case. The four write capabilities deliberately carry **no**
`session_timeout` outcome — after a session dies, the in-progress review page and its
`_token` are gone, so "retry the current step" would target a stale/nonexistent form.
Leaving it undetected routes it to the generic hard-failure path, the only one that calls
`tryEscalate` — verified live (below), not just designed.

## Safety, evidence, and escalation survival

Guardrails needed zero code changes — MERIDIAN's routes are just more entries in the same
`config/allowlist.json`, each independently marked safe/risky (Place Hold's review *and*
post both risky, defense in depth alongside the app's own 403 check). Evidence is the same
JSONL logger and screenshots for every run, same redaction. One real lesson: redaction
happens at string-serialization time on the on-disk `discovery-result.json`, so rebuilding
an artifact from that file (rather than the in-memory result) can corrupt a field whose
literal `name` attribute happens to equal a redacted secret value — hit this for real once
(sign-on's `name="password"` collided with the redacted literal `"password"`), fixed by
always re-running discovery fresh for post-hoc config changes.

Escalation was proven live, end to end: with `meridian-transfer-funds` paused at its real
risky `/post` confirmation, a separate session set MERIDIAN's global `forcedInject=timeout`;
confirming sent the click into the now-injected "YOUR SESSION HAS TIMED OUT" page instead of
a real confirmation; the extract step correctly failed to find a confirmation number that
genuinely wasn't there; with no `session_timeout` outcome defined, it fell through to the
generic hard-failure path and called the real `tryEscalate` → `requestIntervention`. A
genuine "HUMAN INTERVENTION REQUESTED" prompt appeared with a real screenshot; the correct
answer ("abort" — nothing to resume) was recorded, and confidence honestly dropped from 6/6
to 5/6 clean runs. Trail at `evidence/runs/replay-2026-08-27T01-08-57-002Z/`.

## What was cut

- **Balance/share output scoped to the first (topmost) row only** — the shares table is
  variable-length and variably-typed per member (confirmed across all five seed members); a
  full itemized schema needs a variable-length output type this system doesn't have yet.
- **No idempotency key on retried transient-fault POSTs** — accepted per the brief's own
  "resets on redeploy" framing; a real fix needs a client-generated key threaded through
  review→post.
- **HTTP status stays evidence-only**, never a classification input — MERIDIAN's page text
  was unambiguous enough in every case tested; the natural next increment for a target with
  less distinctive error pages.
- **Minor tooling limitation, not a system bug**: two risky confirmations in one process
  (Place Hold's review, then post) can lose a piped second answer when *finite* piped input
  arrives in one buffered chunk (`readline` discards its unconsumed buffer on `close()`).
  Doesn't affect a real operator typing live — worked around here with an unbounded pipe.

**Next with more time**: one more full demo rehearsal; itemize the full shares table; add
idempotency keys to the three `/post` steps.
