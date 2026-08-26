# Testing Strategy

## In one sentence

The near-pure logic (does this checkpoint pass, is this text a secret, does this route match
the allowlist, does the replay state machine recover/retry/escalate correctly) has a real,
fast, 234-test Vitest suite behind it — but the two things that can't be honestly faked, a
real browser and an LLM's actual judgment, are verified with real, checked-in evidence
instead, because a test that mocks either of those would only prove the mock behaves the way
its author assumed, not that the system works.

---

## Part 1 — For everyone: two different kinds of "tested"

### The analogy

You can absolutely test, in a lab, that a car's brakes physically stop the car — every single
time, under controlled conditions, at a given speed, on a given surface. That's a real,
repeatable, automatable test. It tells you something true and useful.

What you *can't* do is "mock" whether a real human driver makes a good judgment call in heavy
traffic. You can't write a fake driver that stands in for a real one and assert "the driver
should brake now" — that only tests whether your fake driver does what you, the test author,
already assumed a driver would do. It proves nothing about real driving. For that, there's
only one honest option: you actually watch real driving footage, in real traffic, and see what
happened.

This project has both kinds of things in it. The "brakes" are things like: does a saved
checkpoint correctly detect the word "expired" on a page, does the redaction logic correctly
mask a password, does the replay engine correctly retry a step exactly once after recovery.
Those are mechanical, deterministic, and testable in a lab, so they get a real automated test
suite. The "driver" is: does a real AI model, looking at a real page, correctly decide to click
the button now labeled "Log In" instead of "Sign On." That can't be honestly faked — so instead
of pretending to test it, this project runs the real thing and keeps the recording.

### A concrete walkthrough

Running the automated ("lab") suite for real, on this exact repo, right now:

```bash
npm test
```

```
 Test Files  28 passed (28)
      Tests  234 passed (234)
   Start at  00:34:39
   Duration  650ms (transform 1.10s, setup 0ms, import 1.94s, tests 236ms, environment 3ms)
```

234 tests across 28 files, done in well under a second, with no browser window opening and no
network call going out anywhere — because none of it needs a real page or a real model to
prove itself.

Contrast that with proving the AI's actual judgment works. There's no automated assertion for
that; instead there are real, checked-in recordings in `/evidence` of the AI actually doing the
thing: a real discovery run that actually signed on to the real mock-bank app and actually
opened an account, a real `vision-fallback-demo` run where the model actually looked at a
canvas-only widget with no clickable structure, correctly figured out it needed to click by
pixel coordinates instead of by button name, and clicked — landing slightly outside the
button's actual bounds, a genuine limitation of the technique, not a bug anyone could have
caught by mocking anything.

### "What happens if...?"

| Situation | What actually happens |
|---|---|
| Someone tries to write a unit test that mocks the Playwright browser page | It isn't done anywhere in this repo. A fake page would need to reimplement real DOM/browser quirks to be worth anything — and a real one of those quirks (a server responding to a POST by re-rendering the same page instead of redirecting) is exactly the kind of thing that only showed up by testing against a **real** `GuardrailsPolicy`, not a hand-written fake of one. |
| Someone tries to write a unit test asserting "Gemini should click the Continue button here" | Not done either. The discovery-agent and replay tests script the model's **output** (a fixed sequence of tool calls) to test the surrounding loop's mechanics — does resuming after escalation actually continue the loop, does three identical failed attempts actually trigger dead-end detection — never a claim about what a real model would decide. |
| A class's own internal state makes writing a plain fake impractical | `GuardrailsPolicy` parses and caches an allowlist config file internally, so `replay-engine.test.ts`'s POST-only-route regression test builds a **real** `GuardrailsPolicy` against a real temporary JSON config file on disk instead of faking its `authorize()` method. |
| The automated suite passes but a real run still finds a bug | It happened for real, more than once: an adversarial review after the first pass found and fixed a route-allowlist bypass via string-prefix matching, recovery actions quietly bypassing the guardrail layer, a replay retry that skipped re-verifying its own checkpoint, and an escalation path that had zero real evidence despite being claimed as verified. |
| A secret shows up in a place key-based redaction wouldn't think to look | This is a real, documented bug this project's own tests exist to pin down: a discovery goal string embedded a password inside a generically-named `goal` field, which key-based redaction alone missed entirely — fixed by adding value-based redaction (`sensitiveValues`), now covered by `redaction.test.ts`. |
| CI needs to run this suite with no browser and no API key available | It already works that way — `npm test` needs neither, which is exactly why it's the thing that runs in `.github/workflows/ci.yml` on every push, while the real evidence runs stay a manual, checked-in artifact. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Two different claims need two different kinds of proof:

1. **"This piece of logic behaves correctly for a given input."** This is a claim about
   deterministic code — checkpoint evaluation, redaction, route matching, state-machine
   transitions. It's fully testable in the conventional sense: give it an input, assert the
   output, run it in milliseconds, run it in CI on every push.
2. **"The real browser does what we need," and "the real model makes a reasonable call."**
   These are claims about a live, non-deterministic dependency and a live judgment call. Mocking
   either one doesn't test the claim — it tests whether the mock matches the test author's own
   mental model of the dependency, which is precisely the thing you can't trust yet. The brief
   itself takes this position explicitly: real evidence is the stronger signal, because "we
   can't assess a description of it."

So the two are deliberately kept apart rather than blurred into one suite that quietly proves
less than it looks like it proves.

### What

As of this pass: **234 tests across 28 files**, all in `src/**/*.test.ts`, run via `npm test`
(Vitest). The full list of test files:

```
src/agent/discovery-agent.test.ts        src/agent/model-retry.test.ts
src/api/status.test.ts                   src/api/tenant-resolution.test.ts
src/artifact/catalog.test.ts             src/artifact/recorder.test.ts
src/artifact/registry.test.ts            src/artifact/schema.test.ts
src/artifact/stability.test.ts           src/artifact/tenant-override.test.ts
src/cli/agent-chat.test.ts               src/cli/agent-invoke-demo.test.ts
src/dashboard/metrics.test.ts            src/dashboard/render.test.ts
src/escalation/controller.test.ts        src/escalation/prompt.test.ts
src/evidence/audit-report.test.ts        src/frontend/planner.test.ts
src/guardrails/allowlist.test.ts         src/guardrails/policy.test.ts
src/guardrails/redaction.test.ts         src/http/api-key-auth.test.ts
src/replay/assisted-recovery.test.ts     src/replay/checkpoint.test.ts
src/replay/drift-loader.test.ts          src/replay/drift.test.ts
src/replay/execution-policy.test.ts      src/replay/replay-engine.test.ts
```

What that suite covers, mapped to real modules:

- **Checkpoint evaluation** (`src/replay/checkpoint.ts`, tested in `checkpoint.test.ts`) — URL
  templates, wildcards, text matching, malformed-input guards.
- **Redaction** (`src/guardrails/redaction.ts`'s `redact()`/`scrubString()`, tested in
  `redaction.test.ts`) — key-based masking, value-based masking (the credential-in-a-
  generic-field bug above), non-string and nested-value masking, and a deliberate limit on
  short-value substring scrubbing so a 1-character "secret" doesn't nuke unrelated data.
- **Allowlist route matching** (`src/guardrails/allowlist.ts`, `allowlist.test.ts`) — including
  the origin-vs-prefix bypass class of bug found during adversarial review.
- **`GuardrailsPolicy.authorize()`** (`src/guardrails/policy.ts`, `policy.test.ts`, and reused
  for real — not faked — inside `replay-engine.test.ts`'s POST-only-route regression test).
- **Confidence/registry math and multi-run stability** (`src/artifact/registry.ts`,
  `src/artifact/stability.ts`'s `computeStabilitySignal`, tested in `registry.test.ts` /
  `stability.test.ts`).
- **The recorder** (`src/artifact/recorder.ts`, `recorder.test.ts`) — building a typed artifact
  out of a finished discovery transcript.
- **Schema validation** (`src/artifact/schema.ts`'s Zod schema, `schema.test.ts`) — cross-field
  validation, not just per-field shape checks.
- **Tenant overrides** (`src/artifact/tenant-override.ts`, `tenant-override.test.ts`) — patch
  application, and that an override referencing a stepId/strategy/known-outcome that doesn't
  exist throws instead of silently no-oping.
- **The replay engine's own recovery/retry/escalation state machine**
  (`src/replay/replay-engine.ts`, `replay-engine.test.ts`, plus `execution-policy.test.ts`,
  `drift.test.ts`, `drift-loader.test.ts`, `assisted-recovery.test.ts`) — recovery routing
  actions through the same `policy.authorize()` as everything else, the post-recovery retry
  re-verifying its own checkpoint rather than assuming success, landed-URL re-checks against
  the allowlist even after an escalation-resume, and the bounded assisted-recovery module's
  DOM/vision tool resolution.
- **The discovery loop's own control flow** (`src/agent/discovery-agent.ts`,
  `discovery-agent.test.ts`) — escalate → resume → finish, dead-end detection after three
  identical failing actions (and that varying free-text `reasoning` doesn't reset that
  counter), risky-action confirm/decline.
- **The escalation decision logic** (`src/escalation/controller.ts`'s
  `resolveInterventionDecision`, `controller.test.ts`; `src/escalation/prompt.ts`'s
  `promptLine`, `prompt.test.ts`) — including the real bug where a closed stdin stream (`null`)
  used to collapse into the same value as a deliberate blank-Enter resume (`""`), which would
  have silently resumed an unattended, unreviewed escalation.
- **The capability API and tenant resolution** (`src/api/status.test.ts`,
  `src/api/tenant-resolution.test.ts`, `src/http/api-key-auth.test.ts`) — result-to-HTTP-status
  mapping and file-not-found / tenantId-mismatch handling against real temp files, not mocks.
- **The conversational front end** (`src/frontend/planner.test.ts`) — plan-extraction and
  credential-redaction logic.
- **The dashboard and compliance export** (`src/dashboard/metrics.test.ts`,
  `src/dashboard/render.test.ts`, `src/evidence/audit-report.test.ts`) — cost/time math, the
  cross-tenant drift matrix, HTML escaping of artifact-sourced free text (so it can't inject
  markup into the rendered page), run-type inference, risky-action extraction, and markdown
  escaping.

### How

Three techniques, used deliberately and never blended with "hope the mock is realistic":

1. **A stub `Surface`.** A plain object literal implementing the `Surface` interface
   (`observe`/`perform`/`predictNavigation`/`getVisibleText`/`screenshot`/`currentUrl`/`close`),
   with `perform()` swapped for a per-test closure that reads and writes a small `state` object
   (`{ url, text }`). `replay-engine.test.ts`'s `fakeSurface()` helper is the canonical
   example — it lets a test script exactly what "the browser did" without a real browser
   existing.
2. **A scripted fake model *output*.** `discovery-agent.test.ts`'s `scriptedGenai()` returns a
   fixed queue of tool calls (e.g. `escalate` then `finish`) shaped like a real
   `@google/genai` response — never a claim about what the real model would choose, only a
   fixed script to drive the surrounding loop's mechanics. The same discipline is used for the
   assisted-recovery model calls in `replay-engine.test.ts`.
3. **A real `GuardrailsPolicy` against a real temporary config file**, when a class's own
   private state makes a plain fake impractical. `replay-engine.test.ts`'s "does not falsely
   block a POST-only route re-rendered in place" test writes a real JSON allowlist config to
   `os.tmpdir()`, constructs a real `new GuardrailsPolicy(configPath)`, and exercises it for
   real — because the bug that test guards against (assuming every landed URL was reached via
   GET) lives inside `GuardrailsPolicy`'s own route-matching logic, which a fake `authorize()`
   would have no reason to reproduce.

What deliberately has **none** of the above standing in for it: the real Playwright `Surface`
implementation, and the real Gemini model's judgment about what to click. Those are verified by
real runs checked into `/evidence` — a clean discovery success, an escalation resolved with
`abort`, an escalation resolved with `resume` that completes the goal afterward on the same
live session, replay runs covering all three of `success`/`business_outcome`/`failure`, the
`escalation-resume-replay-demo`'s real confirmation number after a human dismisses an
unexpected interstitial, the cross-tenant reuse pair (same artifact, rebranded tenant, with and
without an override), and the vision-fallback run against the canvas-only fixture that landed
slightly outside the target's real bounds — an honest, checked-in limitation, not a
cherry-picked success.

### Where

- Test files: `src/**/*.test.ts` (list above); run via `npm test` → Vitest.
- CI: `.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on every push/PR to
  `main` — see [`23-continuous-integration.md`](23-continuous-integration.md).
- Real evidence instead of mocks: `/evidence/artifacts/`, `/evidence/runs/`, produced by
  `npm run run-agent`, `npm run escalation-resume-demo`, `npm run escalation-resume-replay-demo`,
  `npm run vision-fallback-demo`, and `npm run replay`.
- The design rationale in prose: README.md's "Type-checking & tests" section, and REPORT.md's
  "Architecture" section's "Verification" paragraph — both say the same thing this file expands
  on.

### Worked technical example

```bash
npm run typecheck
npm test
```

Real output from this repo, right now:

```
 RUN  v4.1.10 /Users/devpatel/Desktop/interface.ai

 Test Files  28 passed (28)
      Tests  234 passed (234)
   Start at  00:34:39
   Duration  650ms (transform 1.10s, setup 0ms, import 1.94s, tests 236ms, environment 3ms)
```

Compare that to the honest cost of verifying real judgment: `npm run vision-fallback-demo`
opens a real headed Chromium window, calls the real Gemini API, and takes tens of seconds —
because it's proving something a unit test structurally cannot.

### Edge cases & failure modes

- **A test author is tempted to mock Playwright's `Page` "just this once."** Not done anywhere
  in this repo — the moment you fake the page, you're testing your own assumption about how the
  page behaves, which is exactly the class of bug (POST re-rendering in place instead of
  redirecting) that a real dependency actually exhibited.
- **A test author is tempted to assert what the model "should" decide.** Also not done — every
  model-facing test scripts a fixed output and tests the loop around it, never the decision
  itself.
- **A class can't be faked cleanly because of private internal state.** Solved by instantiating
  the real class against a real temporary file (`GuardrailsPolicy` + a temp JSON config) rather
  than writing a fake that reimplements — and could silently diverge from — the real logic.
- **The unit suite is green, but a real run still fails.** This has happened for real and is
  treated as a normal, expected outcome of testing two different kinds of claims, not a
  contradiction — see the adversarial-review bug list above, all found by review and real runs,
  not by the unit suite (which was passing the whole time, correctly, for the claims it was
  actually making).
- **CI has no Gemini API key and no display for a headed browser.** The unit suite needs
  neither, by design, so it's what actually runs in CI; the real evidence runs are produced
  and checked in separately, by design, not re-executed on every push.
- **A secret leaks through a path key-based redaction doesn't cover.** `redaction.test.ts`
  documents the exact real case (a password embedded in a generically-named `goal` field) and
  the fix (value-based redaction via `sensitiveValues`), so the regression stays pinned down
  going forward.

## Related docs

- [`01-system-design.md`](01-system-design.md) — the "Verification philosophy" section this
  file expands on
- [`04-discovery-agent.md`](04-discovery-agent.md) — the discovery loop whose control flow is
  unit-tested here, and whose model judgment is evidence-verified instead
- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the replay engine's state
  machine, the largest single piece of unit-tested logic in this repo
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — the escalation decision logic
  covered by `controller.test.ts` and `prompt.test.ts`
- [`09-evidence-and-logging.md`](09-evidence-and-logging.md) — where the real, checked-in runs
  that stand in for browser/model mocking actually live
- [`23-continuous-integration.md`](23-continuous-integration.md) — where this unit suite
  actually runs automatically
- [`../README.md`](../README.md) — "Type-checking & tests" section, in full
- [`../REPORT.md`](../REPORT.md) — "Architecture" section's "Verification" paragraph, and the
  adversarial-review bug list in "Cuts"
