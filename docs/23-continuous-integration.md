# Continuous Integration

## In one sentence

A single automated GitHub Actions job runs on every push and pull request to `main` — type
checking, the unit test suite, and a dependency-vulnerability scan, in that order — so a
mistake is caught by a machine within a couple of minutes instead of discovered later by a
person; there's deliberately no deploy stage and no matrix of operating systems or Node
versions, because this project has neither a deployment target nor cross-platform
variability that would justify one.

---

## Part 1 — For everyone: what is "CI," and why have a robot double-check everything?

### The analogy: an inspector who checks every item the same way, every time

Imagine a small factory where, every time someone finishes assembling a product, an
inspector checks it before it's allowed onto the shelf. The inspector doesn't get tired,
doesn't skip steps when they're in a hurry, doesn't play favorites for the person who made
it, and checks the *exact same list* of things every single time, no matter who made the
product or how confident they felt about it. If something's wrong, the product doesn't go
on the shelf — the person who made it finds out immediately, while the details are still
fresh, instead of a customer finding out weeks later.

**"Continuous Integration" (CI) is that inspector, for code.** Every time someone proposes
a change to this project (by pushing code, or opening a pull request), an automated process
kicks off by itself — no one has to remember to run it — and checks the change the same way
every time: does it still make sense as a program (type-checking), does it still behave the
way the existing tests say it should (running the test suite), and does it now depend on
any code with a newly-discovered security hole (a vulnerability scan). If any of those
checks fail, the change is flagged as broken *before* anyone has to trust it.

### What this project's CI actually does

This project's one CI job (defined in `.github/workflows/ci.yml`, and visible as a
green/red checkmark on GitHub) runs three checks, in order, every time:

1. **`npm run typecheck`** — makes sure every file is internally consistent about what kind
   of data it expects and returns, without actually running any of the program.
2. **`npm test`** — runs the full automated test suite (as of this writing, 303 tests across
   35 files) against a *simulated* version of the browser-driving layer — no real browser
   is opened during this check, which is exactly why this can run inside GitHub's own cloud
   machines with no visible display.
3. **`npm audit --omit=dev --audit-level=high`** — checks every dependency this project
   actually ships (not its developer-only tools like the test runner) against a public
   database of known security vulnerabilities, and fails the whole job if anything
   high-severity or worse turns up.

If all three pass, the change gets a green checkmark. If any one of them fails, it's red —
and that's a real signal to go look, not a decoration.

### A concrete walkthrough

Say someone (or a future version of this same project) pushes a code change that
accidentally breaks something — say, a function that used to return a `string` now
sometimes returns `undefined`, and a test specifically checks for that case.

1. GitHub notices the push and starts a fresh, clean virtual machine (`ubuntu-latest`).
2. It checks out the exact code that was pushed, installs Node.js 20, and runs
   `npm ci` (a strict, reproducible install of every dependency exactly as recorded in
   `package-lock.json`).
3. `npm run typecheck` might pass fine — a wrong return value isn't necessarily a type
   error if `undefined` was already a valid possibility in the type signature.
4. `npm test` runs, and the specific test that checks that function's return value fails,
   with a clear error message showing what was expected vs. what actually came back.
5. The whole CI run is marked failed. On GitHub, this shows up right on the pull request as
   a red X, with a link straight to the failing test's output — so the mistake is visible
   and specific well before anyone merges the change or the mistake affects anything real.

### "What happens if...?"

| Situation | What happens |
|---|---|
| A pushed change has a type error (e.g. passing a number where a string is expected) | `npm run typecheck` fails, CI goes red, before `npm test` even runs. |
| A pushed change breaks an existing unit test's expected behavior | `npm test` fails, CI goes red, with the specific failing test and its expected-vs-actual output shown in the log. |
| A dependency this project ships (not a dev tool) gets a newly-published high-severity CVE, even with no code change at all | The *next* CI run (on the next push/PR) fails on the `npm audit` step, surfacing the new risk automatically rather than it going unnoticed. |
| Someone tries to test something that needs a real browser window | It can't, inside this CI job — CI runs headless with no display, which is exactly why the unit suite is built against a stub `Surface` rather than a real Playwright browser; see [`21-testing-strategy.md`](21-testing-strategy.md) for what *is* verified this way, and how. |
| Someone asks "why isn't there a deploy step that pushes this to a server automatically?" | There isn't one because there's no real deployment target for this project — adding one would be inventing infrastructure this project's actual size and purpose doesn't need. |
| Someone asks "why doesn't CI test on Windows and macOS too, or multiple Node versions?" | It doesn't, because nothing about this codebase is actually sensitive to OS or Node-version differences that matter here — a matrix would add real cost (slower CI, more to maintain) for a variability problem this project doesn't have. |
| All three checks pass | The commit/PR gets a green check on GitHub — the strongest automated signal this repo produces that a change is safe to trust. |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief's own guidance — don't build scaling infrastructure a project's actual size
doesn't call for — applies to CI exactly as it applies to the rest of this system's
architecture (single process, no queues, no database). This repo has no deployment target
of its own (it's a take-home submission, not a service with a production environment to
ship to) and no cross-platform variability that would actually change behavior (it's a
single Node.js/TypeScript codebase with one real runtime target: Node 20+ on Linux, which
is also what the Dockerfiles and any real deployment would use). Building a multi-stage
pipeline with a deploy step and an OS/Node-version matrix here would be exactly the kind of
premature infrastructure the brief warns against — more moving parts to maintain, for
coverage this project doesn't need. One job that answers "does it typecheck and pass tests
on every push" is the right amount of CI for what this project actually is.

### What

`.github/workflows/ci.yml`, in full:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - run: npm run typecheck

      - run: npm test

      - run: npm audit --omit=dev --audit-level=high
```

One job (`build-and-test`), one runner (`ubuntu-latest`), four real steps after checkout and
Node setup.

### How

- **Triggers**: `push` and `pull_request`, both scoped to `branches: [main]` — since this
  project uses a single branch (see
  [`24-git-and-version-control.md`](24-git-and-version-control.md) for why), this
  effectively means "on every commit that reaches or targets the only branch that matters."
- **`actions/setup-node@v4` with `cache: npm`** — pins the exact Node major version
  (`20`, matching `package.json`'s `"engines": {"node": ">=20"}`) and caches
  `node_modules` between runs so `npm ci` doesn't re-download the same dependency tree from
  scratch on every single push.
- **`npm ci` rather than `npm install`** — installs the *exact* versions recorded in
  `package-lock.json`, failing outright if the lockfile and `package.json` disagree, rather
  than potentially resolving a slightly different dependency tree than what's checked in.
  This is the standard "reproducible CI install" choice, deliberately stricter than what
  you'd run locally day-to-day.
- **`npm run typecheck`** (`tsc --noEmit`) runs before `npm test` on purpose — a type error
  is cheaper and faster to report than letting the test runner get further into a build that
  was never going to be valid.
- **`npm test` (`vitest run`) needs no real browser.** The comment directly above this step
  in `ci.yml` spells out why: "Vitest runs against a stub Surface -- no real Playwright
  browser or network calls are needed, so this job does not run `playwright install`." This
  is a direct consequence of the verification philosophy described in
  [`01-system-design.md`](01-system-design.md) and detailed in
  [`21-testing-strategy.md`](21-testing-strategy.md): near-pure logic (guardrail checks,
  redaction, the recorder, the replay engine's state machine) is unit-tested against small
  fakes; the real Playwright browser and an LLM's actual judgment are deliberately verified
  by real, checked-in runs in `/evidence` instead, not mocked in CI.
- **`npm audit --omit=dev --audit-level=high`** is a real gate, not a decorative step — the
  comment in `ci.yml` notes the repo "currently [has] 0 known high/critical vulnerabilities
  in production dependencies, so this is expected to pass." `--omit=dev` scopes the scan to
  what actually ships at runtime (excluding `typescript`, `tsx`, `vitest`, `@types/*`, which
  never run in production and whose vulnerabilities, if any, can't be exploited through a
  deployed instance of this system) — matching the same `npm prune --omit=dev` split used in
  every Dockerfile's build stage. `--audit-level=high` means only high/critical findings
  fail the build; lower-severity advisories don't block a push on their own.

### Worked technical example

```bash
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
```

Realistic output on a clean, passing state (matching this repo's actual current status per
`SECURITY.md`):

```
$ npm run typecheck
> tsc --noEmit
(no output -- success)

$ npm test
> vitest run
 Test Files  35 passed (35)
      Tests  303 passed (303)
   Duration  ...

$ npm audit --omit=dev --audit-level=high
found 0 vulnerabilities
```

A pull request against `main` shows exactly these three steps (plus checkout/setup) as
individual, inspectable log sections in GitHub's Actions tab, with a single green check
summarizing all of them once they all pass.

### Edge cases & failure modes

- **A dependency bump introduces a type error somewhere unrelated to the bump's intended
  purpose** — caught by `typecheck` before `test` ever runs, exactly the scenario this
  ordering exists for.
- **A flaky test** — this suite is built against small, deterministic fakes (a stub
  `Surface`, scripted fake model output) specifically so it doesn't have this failure mode;
  a real Playwright browser or a live LLM call would introduce exactly the kind of
  non-determinism CI can't tolerate, which is why neither is exercised here.
- **A new CVE is published for a dependency with no code change on this repo's side** — the
  *next* CI run (triggered by the next push or PR) is the one that surfaces it; there's no
  scheduled/cron audit run today, so a long gap with no commits means a gap in this
  particular signal — a real deliberate trade-off, not an oversight, matching this project's
  general "don't build more automation than the current scale needs" stance.
- **Someone expects CI to also verify the Dockerfiles by actually building them** — it
  doesn't; see [`22-docker-and-containers.md`](22-docker-and-containers.md) for why the
  container path is "reviewed for correctness," not build-verified, in this pass.
- **Someone expects a required-status-check branch protection rule blocking merges on red
  CI** — this workflow file only defines what runs; whether GitHub is configured to block
  merges on failure is a separate repository setting, not something `ci.yml` itself
  enforces.

## Related docs

- [`21-testing-strategy.md`](21-testing-strategy.md) — what the unit suite this CI job runs actually covers, and what it deliberately doesn't
- [`22-docker-and-containers.md`](22-docker-and-containers.md) — the other piece of infrastructure added in the same pass, kept equally minimal
- [`24-git-and-version-control.md`](24-git-and-version-control.md) — why `main` is the only branch these triggers need to care about
- [`02-glossary.md`](02-glossary.md) — the short definition of "CI" this file expands on
- [`../README.md`](../README.md) — "Continuous integration" and "Type-checking & tests" for the same story with real commands
- [`../REPORT.md`](../REPORT.md) — the original design write-up this expands on
