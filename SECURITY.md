# Security

This consolidates the security-relevant design decisions that are otherwise scattered across
`REPORT.md` (§3 Determinism & error handling, §5 Escalation & handoff, §6 Safety, §8 Stretch
goals) into one place, and documents the authentication layer added during the production-
hardening pass. It's a threat model and a set of decisions, not a compliance checklist —
scoped to what this system actually is: a small number of Node/Express services plus a set
of CLIs, none of them multi-tenant-in-the-identity sense, none of them internet-facing by
default.

## Reporting a concern

This is a take-home/demo project, not a maintained open-source package with a security team.
If you're reviewing this as part of the interface.ai hiring process and see something that
concerns you, raise it directly rather than filing an issue.

## Secrets

- `GEMINI_API_KEY`, `CAPABILITY_API_KEY`, `DASHBOARD_PASSWORD` all live in `.env`
  (git-ignored — see `.gitignore`) and are never hard-coded. `.env.example` documents every
  variable with a placeholder, never a real value.
- The one hard-coded secret in the repo, `apps/mock-bank`'s Express-session secret, is
  explicitly labeled `"mock-bank-dev-secret-not-sensitive"` in the source: mock-bank is the
  fake *target* application this system automates (standing in for a real third-party bank
  we don't control), not part of the system being hardened here — see "What's deliberately
  not hardened" below.
- `npm audit --omit=dev` reports 0 known vulnerabilities as of this pass; CI runs the same
  check on every push (`.github/workflows/ci.yml`) so a newly-disclosed CVE in a dependency
  fails the build rather than going unnoticed.
- Redaction (`src/guardrails/redaction.ts`) masks both sensitive-looking field *names*
  (password, token, SSN...) and any occurrence of a *registered secret value*, regardless of
  field name — the second mechanism exists because of a real bug found while producing
  evidence: the discovery goal string embeds a credential in plain English
  ("...password 'demo_password'..."), and the very first log line would otherwise have
  written it in the clear before the discovery loop had "seen" the password field. Every
  other HTTP-facing or LLM-facing surface added since (the capability API, the conversational
  front end, the compliance/audit export) registers sensitive values the same way, before the
  first place they could leak, not after.

## Authentication

Two HTTP surfaces, two different mechanisms, chosen for who actually calls each one — not a
one-size-fits-all identity layer:

- **Capability API** (`src/api/server.ts`, `GET /capabilities` and
  `POST /capabilities/:id/invoke`) — called by code (an agent, a CLI), not a human clicking
  around. Requires `Authorization: Bearer <CAPABILITY_API_KEY>` (or `X-API-Key`) on every
  route except `/health`. `/invoke` can trigger a real, guardrail-checked action against the
  target system, and `/capabilities` alone discloses confidence/approval state that's real
  operational data — both legs need the same gate, not just the one that writes.
- **Dashboard** (`src/dashboard/server.ts`) — opened directly in a browser by a human
  operator. Uses HTTP Basic auth (`DASHBOARD_PASSWORD`) specifically because browsers prompt
  for Basic credentials natively; a Bearer-token scheme would need a login form this
  read-only ops page has no other reason to have.
- Both share one comparison primitive (`src/http/api-key-auth.ts`): the candidate and the
  expected secret are each SHA-256 hashed before `crypto.timingSafeEqual`, so neither a
  length-based early return nor a byte-by-byte early exit leaks anything about the real
  secret through response timing.
- Both **fail closed and loud**: if `CAPABILITY_API_KEY` / `DASHBOARD_PASSWORD` isn't set,
  the server throws at startup and refuses to listen at all, rather than silently serving
  unauthenticated. An unset env var should never be indistinguishable from "auth
  intentionally disabled."
- `/health` is intentionally the one unauthenticated route on every service (including
  mock-bank) — container orchestrators and uptime checks need it to work without a
  credential, and it discloses nothing beyond "the process is up."
- Deliberately not built: per-user identity, roles, or an audit trail of *which human*
  approved a risky action or an artifact (`npm run approve`, the `onRiskyStep` confirmation
  prompt) — both record *that* a decision was made and *when*, not *who* made it. A single
  shared secret per surface is the right amount of mechanism for "one caller class per
  surface," but a real multi-operator deployment would need an identity provider on top of
  this, not instead of it. The compliance/audit report (`npm run compliance-report`)
  discloses this limitation in its own generated output, not just here.

## Guardrails: what's allowed to happen at all

- `config/allowlist.json` is route-pattern + HTTP-method based. Every action — discovery or
  replay — is checked via `GuardrailsPolicy.authorize()` before it executes, and for a
  click/navigate, `Surface.predictNavigation()` resolves the actual pending destination (a
  form's real method/action, or a link's href) so the check reflects what will really happen,
  not a guess.
- Base-URL comparison is origin-based (`new URL(...).origin`), not a string-prefix check — a
  real bug found and fixed during this build: a naive `startsWith` check would have let
  `http://localhost:4000.evil.example.com` or `http://localhost:4000@evil.com`
  (userinfo-in-URL) both pass as "allowed," since both literally start with the configured
  base string.
- Anything outside the allowlist is blocked outright, with one deliberate three-way
  distinction in `predictNavigation`'s return value: a real destination (checked normally),
  `null` for "exists but can't determine where it goes" (fails *closed*, since that's exactly
  the JS-driven-write case the allowlist exists to catch), and `undefined` for "doesn't even
  resolve on the current page" (safe to let `perform()` fail on its own — collapsing this into
  "block" was an early bug that misreported a legitimate business outcome, a missing link on
  a permission-denied page, as a security block).
- Write actions are `risky` and always require either interactive confirmation or an
  `--allow-risky` flag that only takes effect once an artifact is `approve`d *and* its
  drift-adjusted confidence hasn't degraded (the confidence circuit breaker,
  `src/replay/execution-policy.ts`) — an agent calling the capability API can't get looser
  guardrails than a human running the CLI would, and neither can an assisted-recovery
  proposal: every recovery/retry path re-runs the same `authorize()` check and a landed-URL
  allowlist re-check before treating a recovered step as real.
- `click_at_coordinates` (the vision-grounded fallback's only action) is unconditionally
  classified `risky` — its destination is fundamentally unverifiable in advance — and is
  routed through the same confirm/decline contract as every other risky action rather than a
  special-cased blanket refusal, which would make the fallback permanently inert.

## Input validation at trust boundaries

- Every value crossing from an HTTP request body or CLI flag into the artifact/replay
  pipeline goes through Zod schema validation (`src/artifact/schema.ts`) before it's treated
  as a real artifact.
- **Path traversal, found and fixed in this pass:** `tenantId` on the capability API's
  invoke request reaches `src/api/tenant-resolution.ts`'s `resolveEffectiveArtifact`, which
  builds a filesystem path (`config/tenant-overrides/<tenantId>.json`) to load. The original
  version built that path directly from the untrusted `tenantId` with no validation — a
  value like `"../../../../etc/passwd"` would have resolved outside the overrides directory
  entirely. Fixed by validating `tenantId` against `^[a-zA-Z0-9_-]+$` (the same charset real
  tenant filenames use) before any path is built, not after. See `REPORT.md` §8
  "agent-facing capability interface" for the full writeup and how it was found (auditing
  every place a request-body value reaches `fs`/`path` in this codebase, not a scanner).

## Containers

- Secrets are never baked into an image — `docker-compose.yml` supplies
  `CAPABILITY_API_KEY`/`DASHBOARD_PASSWORD` via `env_file: .env` at container start, the
  same fail-closed-if-unset behavior as running these services directly.
- `mock-bank` and `dashboard` (`Dockerfile.mock-bank`, `Dockerfile.dashboard`) run as
  `node:20-slim`'s built-in non-root `node` user — no reason a plain Express app needs root
  inside its container.
- `capability-api` (`Dockerfile.capability-api`) deliberately still runs as root: it's
  Playwright's own documented default (Chromium's sandbox has real permission requirements
  under a non-root user) and it needs write access to the bind-mounted `evidence/` volume.
  Worth revisiting if this ever goes further than a demo, not an oversight.
- None of this has been validated against an actual `docker build`/`docker compose up` —
  Docker wasn't available in the environment that produced these files. The `dist/` output
  paths were verified by actually running `npx tsc` against this repo's real `tsconfig.json`
  rather than guessed; the base-image tag was verified to exist via the registry API. Treat
  the Dockerfiles as reviewed-for-correctness, not build-tested.

## Escalation & handoff

A risky-action decline, or a dead end the discovery loop can't route around on its own (e.g.
a permission-denied member no automation can fix client-side), pauses the run rather than
failing it outright or guessing. `src/escalation/` hands control to a human against the
*same* live browser session; the human's resolution (`abort` or `resume`) is captured as real
evidence, and on `resume`, execution continues on that same session rather than restarting.
See `REPORT.md` §5 for the full design and a real captured example of both outcomes.

## Rate limiting & transport hardening

- `helmet()` is applied to all four Express services (mock-bank's `contentSecurityPolicy` is
  explicitly disabled — see the comment in `apps/mock-bank/src/server.ts` for why: the
  vision-fallback negative-control fixture needs an inline `<canvas>` script, and mock-bank
  itself isn't the system being hardened, see below).
- **`hsts: false` on all four**, a deliberate override of helmet's own default — and a real
  bug found live, not a preemptive guess. Every one of these servers is plain HTTP on
  localhost only; none is ever served over TLS in any context this repo runs in (checked:
  `docker-compose.yml` has no TLS termination either). Helmet's default
  `Strict-Transport-Security` header promises exactly the opposite — "always use HTTPS for
  this origin" — and Safari/WebKit believed it: reproduced with Playwright's WebKit engine
  against `src/chat-ui/server.ts`, the *next* same-origin requests for `style.css`/`chat.js`
  after the header landed were silently upgraded to `https://localhost:4800/...` and failed
  outright (no TLS listener to answer), while the page's own initial navigation — already in
  flight before the header was received — loaded fine. That's exactly "no CSS, everything
  else looks fine," reported live by a real user in a real Safari session. Worth noting for
  anyone hitting this themselves: once a browser receives this header for a host, it caches
  the policy (helmet's default `max-age` is one year) independent of anything the server
  sends afterward — removing the header here stops it happening to any *new* client from now
  on, but a browser that already cached the old header for `localhost:4800` needs that one
  entry cleared once (e.g. Safari → Settings → Privacy → Manage Website Data → remove
  "localhost", or Clear History) before it'll load correctly again.
- `POST /capabilities/:id/invoke` has its own rate limit (20 requests/minute per the default
  `express-rate-limit` key), independent of read traffic to `/capabilities`, since invocation
  can trigger a real action against the target system.
- Every request across all three services is logged as one structured JSON line to stdout
  (`src/http/request-log.ts`) — method/path/status/duration only, deliberately never headers
  or bodies, so the access log can't become a second, unredacted channel for the same
  credentials `src/guardrails/redaction.ts` already takes care to mask everywhere else.

## What's deliberately not hardened, and why

- **`apps/mock-bank`.** This is the fake *target* application the automation system drives —
  standing in for a real third-party bank whose internal security is not ours to change. Its
  own login form, session handling, and lack of rate-limiting are not this project's concern;
  what matters is that the *automation system's* guardrails behave correctly against it,
  which is what §6 and this document's "Guardrails" section above are about.
- **Per-tenant/per-role authorization.** The allowlist is static per run, not scoped by
  tenant or operator role; the two auth mechanisms above are single-shared-secret, not
  per-user. Both are proportionate to "one caller class per surface" as this system exists
  today, not to a multi-tenant SaaS deployment — see "Authentication" above for what a real
  deployment would need to add on top.
- **A full audit-trail identity layer.** Covered under "Authentication" above and disclosed
  directly in the compliance report's own output, not just here.
- **Infrastructure this system's actual scale doesn't need**: no service mesh, no message
  queue, no database (there isn't one — mock-bank's data is in-memory by design), no
  Kubernetes/autoscaling. Section 8's own "don't build scaling infrastructure you don't need"
  applies here as much as it did to the scheduled-canary stretch goal — see `REPORT.md`
  "Multi-run stability."
