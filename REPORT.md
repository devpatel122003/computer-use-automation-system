# Design Report

*This is the ~1–3 page write-up the brief asks for. Each section below is deliberately
short — the reasoning, trade-offs, real bugs found and fixed, and the evidence behind every
line here live in `docs/`, one topic per file; each section links straight to its own. Full
index: [`docs/README.md`](docs/README.md).*

## 1. Architecture

A single Node/TypeScript process, no queues or services (the brief's own "don't build
scaling infrastructure you don't need"). Seven modules, one job each: `Surface` (perceive/act
on a UI via a role-based DOM scan with a locator fallback chain, one Playwright
implementation today), `agent` (discovery: observe → one Gemini function-call → guardrail
check → act → log, repeat), `artifact` (the typed capability schema + a recorder), `replay`
(zero-model deterministic execution), `guardrails` (one allowlist/risk policy consulted by
*both* discovery and replay), `escalation` (pause/human-takeover/resume, shared by both), and
`evidence` (structured JSONL + screenshots). Discovery and replay share the exact same
locator-resolution and guardrail code path, so an artifact is a faithful contract, not a
second implementation of "how to click things."

See [`docs/01-system-design.md`](docs/01-system-design.md) for the full module map and data
flow, and [`docs/04-discovery-agent.md`](docs/04-discovery-agent.md) for the discovery loop
itself.

## 2. Artifact schema

A capability is a contract, not a step list: typed `inputParams`/`outputSchema` separate
from `steps`, an ordered locator fallback chain per step (each candidate carrying its own
confidence + rationale), and `knownOutcomes` as first-class schema citizens
(`business_outcome` / `recoverable` / `hard_failure`) rather than exceptions bolted on after
the fact. Zod cross-field validation (`superRefine`) catches a dangling param/step reference
at parse time, not three steps into a live replay.

See [`docs/05-artifact-schema.md`](docs/05-artifact-schema.md) for every field, why it's
shaped that way, and a worked example against real evidence.

## 3. Determinism & error handling

Replay never calls a model; every action resolves through the same locator chain discovery
recorded. The three-way result split (`success` / `business_outcome` / `failure`) is the core
of the replay contract, backed by real evidence for every leg — including a genuine
unanticipated input producing a real `failure` with a step id, expected/observed, and a
screenshot, not a crash or a misclassified business outcome. `session_timeout` gets one real
recovery attempt (re-authenticate, retry). A real transient-failure class was found live
against MERIDIAN specifically (a genuine external, network-latency-bound target, unlike the
local mock-bank): a Playwright navigation race inside `getVisibleText()` — checkpoint/
known-outcome detection's hottest call site — fixed with a narrow, unit-tested retry rather
than a broad try/catch, applied to all three real `.evaluate()` call sites in
`playwright-surface.ts`, not just the one caught live.

See [`docs/06-deterministic-replay.md`](docs/06-deterministic-replay.md) for the full
three-way contract, the recovery state machine, and every edge case found live (including the
navigation-race fix above).

## 4. Heterogeneity & multi-tenant

The seam is exactly `Surface.observe`/`perform`/`predictNavigation` — a desktop
implementation would be a second implementation of the same three methods against OS
accessibility APIs, with nothing above `Surface` changing. This stopped being purely
hypothetical twice: a vision-grounded coordinate-click fallback is real and live-tested
against a genuine canvas-only fixture (the "no accessibility info at all" case), and
cross-tenant reuse is built, not just designed — the same recorded artifact, applied to a
second, rebranded tenant via a small named override, with a real drift comparison in the
dashboard.

See [`docs/03-surface-abstraction.md`](docs/03-surface-abstraction.md) for the perception
seam, [`docs/11-cross-tenant-reuse.md`](docs/11-cross-tenant-reuse.md) for multi-tenant reuse,
and [`docs/13-assisted-fallback-and-vision.md`](docs/13-assisted-fallback-and-vision.md) for
the vision-grounded fallback.

## 5. Escalation & handoff

Three real triggers: the model self-escalating, a risky step needing confirmation, or a
replay hard failure. The browser runs headed specifically so "ceding control" is real — a
human operates the exact same `Page` a script would, not a description of the problem to
interpret. `EscalationController` blocks on a real terminal prompt for the CLI path; a
second, HTTP-native path (`HttpEscalationRegistry`) does the same job for the capability API
and the console, so a genuine mid-replay hard failure can be resolved from a live screenshot
plus Resume/Abort buttons instead of only a terminal — verified live both ways: a clean
abort, and a resume that correctly still fails (not silently "succeeds") when nothing was
actually fixed.

See [`docs/08-escalation-and-handoff.md`](docs/08-escalation-and-handoff.md) for the full
control-transfer model, real bugs found while building it, and every piece of evidence.

## 6. Safety

A route-pattern + HTTP-method allowlist, checked before every action via
`GuardrailsPolicy.authorize()` using the *actual* predicted destination (a form's real
method/action, a link's real href) — not a guess. Origin-based base-URL comparison, not a
string-prefix check (the earlier version had a real bypass). Risky actions always require
confirmation unless an artifact is `approve`d *and* its confidence hasn't since degraded — a
circuit breaker, not a static flag, and one that had to be rebuilt with fresh evidence more
than once after real failures legitimately dropped it. Redaction masks both
sensitive-looking field names and any registered secret value wherever it appears, verified
by grepping the entire evidence tree for plaintext credentials.

See [`docs/07-guardrails-and-safety.md`](docs/07-guardrails-and-safety.md) for the allowlist
model and the redaction mechanism, and [`SECURITY.md`](SECURITY.md) for the consolidated
threat model.

## 7. Cuts

`knownOutcomes` are human-authored, not auto-mined — a single happy-path discovery run never
observes its own error states. No literal-to-parameter generalization pass — param mapping is
a small, explicit, hand-maintained table. UI-drift diffing is single-artifact/single-machine,
not fleet-scale. Code generation is the one Section 8 stretch goal skipped on purpose, as the
least load-bearing of the six for what this system is for. `close-sub-account` targets "the"
sub-account by page position, not a specific id — a real robustness limit, not a crash; a
production version needs a real `subAccountId` input param instead.

Full detail on each of these, and every other named limitation, is in the "Edge cases" /
"Cuts" section of the relevant topic doc in `docs/` (see the index).

## 8. Stretch goals: five of six, built for real

Confidence & approval (an actual circuit breaker, not a badge —
[`docs/10-confidence-and-approval.md`](docs/10-confidence-and-approval.md)), cross-tenant
reuse ([`docs/11-cross-tenant-reuse.md`](docs/11-cross-tenant-reuse.md)), an agent-facing
capability API ([`docs/14-capability-api.md`](docs/14-capability-api.md)), assisted/
vision-grounded LLM recovery
([`docs/13-assisted-fallback-and-vision.md`](docs/13-assisted-fallback-and-vision.md)), and
multi-run stability ([`docs/17-multi-run-stability.md`](docs/17-multi-run-stability.md)) —
each with its own real evidence and tests, not shortcuts. Code generation is the one skipped
(§7).

## 9. Beyond both briefs

A unified, multi-target demo console (chat + capability catalog + per-target demo scripts + a
live human-escalation card, one process, every target switchable at runtime) and a "register
a new target" form proving the same discovery agent generalizes to a UI it has never seen —
live-tested against an independently-built fixture app, not a relabeled copy of an existing
target. Neither is required by either brief.

See [`docs/26-extended-console-and-onboarding.md`](docs/26-extended-console-and-onboarding.md)
for the full write-up, kept separate on purpose so it doesn't crowd §§1–8 above.

---

**The MERIDIAN CORE adaptation** (pointing this same core at a real, live legacy target
instead of `mock-bank`) has its own short write-up: [`ADAPTATION.md`](ADAPTATION.md).
