# The Capability API

## In one sentence

A small HTTP surface — `GET /capabilities` to discover what's available, `POST
/capabilities/:id/invoke` to run one by name with typed arguments — that lets any authorized
caller, human or AI agent, do exactly what the CLI does, through exactly the same checks,
with no shortcuts.

---

## Part 1 — For everyone: the counter, not the kitchen

### The real-world analogy

Think of a restaurant. Customers don't walk into the kitchen and start cooking — they go to
the counter, look at a menu (what's available, what it costs, what it needs), and place an
order by name: "one #7, no onions." The counter takes the order and hands it to the kitchen.
The kitchen doesn't care *who* placed the order or *how* politely they asked — it cooks the
same #7 the same way every time, checking the same food-safety rules every time.

The capability API is the counter. `GET /capabilities` is the menu — it tells you what's
available, what arguments it needs, and (something a restaurant menu doesn't do) how
trustworthy each item currently is. `POST /capabilities/:id/invoke` is placing the order.
The "kitchen" — the actual browser automation, the safety checks, the confirmation rules for
anything risky — is the exact same kitchen a human uses when running commands directly from
a terminal. An AI agent placing an order through this counter can never get a laxer kitchen
than a person standing right there with a keyboard.

### A concrete walkthrough, using the real demo script

`src/cli/agent-invoke-demo.ts` plays the role of "the agent-facing product" — the thing that
decides *what* to do and calls this API to make it happen, without needing to know anything
about browsers, locators, or Playwright.

```bash
npm run capability-api
# -> Capability API listening on http://localhost:4700

npm run agent-invoke-demo
```

First, it discovers what's available:

```
Discovering capabilities: GET http://localhost:4700/capabilities
Found 1 capability(ies):
  - open-sub-account ("Open Sub-Account") v1 [draft] -- (username:string, password:string, memberId:string, accountType:string, initialDeposit:string)
```

Then it invokes it by name with typed arguments:

```
Invoking "open-sub-account" by name with typed args (allowRisky=true): POST http://localhost:4700/capabilities/open-sub-account/invoke
```

If the artifact is still `draft` (nobody has reviewed and approved it yet), the response
comes back HTTP 422 — the risky step (actually opening the account) was declined
automatically, because there's no human at a keyboard on the other end of an HTTP request to
ask "are you sure?" Running `npm run approve -- --artifact
evidence/artifacts/open-sub-account.artifact.json` first, then re-invoking with real member
10001's details, produces a real success with a confirmation number, HTTP 200. Real,
checked-in evidence for all four possible outcomes over HTTP — declined-risky (422), success
(200), a `business_outcome` like "no such member" (200), and a bad-parameters error (400) —
lives under `evidence/runs/replay-2026-08-25T18-3*`.

### "What happens if...?"

| Situation | What happens |
|---|---|
| The capability id in the URL doesn't exist on disk | HTTP 404, and — deliberately — no run directory or evidence log is ever created, because there's no artifact context yet to log against. |
| The artifact is `draft` and the request tries a risky action | The risky step is declined automatically (no operator to ask), same outcome as running the CLI without a confirmation prompt wired up. |
| The artifact is `approved`, but its confidence has recently degraded (e.g. UI drift) | Same automatic decline, even though it's technically "approved" — approval alone isn't enough once the track record looks shaky. |
| Required parameters are missing or wrong type | HTTP 400, with a message naming the missing/invalid parameter — never a silent guess. |
| A `tenantId` is included in the request body | That tenant's branded variant of the capability is used instead of the base one — its own independent approval/confidence, not inherited from the base artifact. |
| The `tenantId` is something like `"../../../etc/passwd"` | Rejected outright with HTTP 400 before any file is touched — this exact bug existed once and was fixed; see below. |
| No API key, or the wrong one, is sent | HTTP 401 on every route except `/health` — the server won't even look at the request body. |
| The capability API process itself starts with no key configured at all | It refuses to start at all, rather than silently running unauthenticated. |
| Someone calls the API 25 times in one minute trying to invoke actions | The 21st invocation in that minute is rate-limited — read-only discovery calls (`GET /capabilities`) aren't affected, since they can't trigger a real action. |

---

## Part 2 — For engineers: why, what, how, where

### Why

This is the brief's §8 "agent-facing capability interface" stretch goal, and it's the
literal seam Section 1 of the brief describes: *"the agent-facing product decides what to
do; this system is how it reliably and safely does it."* Everything else in this repo is the
second half of that sentence. This API is the door an agent-facing product would knock on to
use it.

**Why a thin wrapper, not a new implementation.** The route handler in `src/api/server.ts`
is almost entirely plumbing around the exact same `replay()` engine, the exact same
`GuardrailsPolicy`, and the exact same confidence-registry gate the `replay` CLI already
uses (see [`06-deterministic-replay.md`](06-deterministic-replay.md) and
[`10-confidence-and-approval.md`](10-confidence-and-approval.md)). There is no separate,
looser code path an agent could take to get an action approved that a human running the CLI
couldn't also get. The one real behavioral difference: there's no operator to prompt for a
risky-step confirmation over HTTP, so `onRiskyStep` is simply never passed — which produces
the *same* decline outcome the CLI has when no confirmation callback is wired up, not a new
one invented for this surface.

### What

Two routes, in `src/api/server.ts`, both requiring a valid API key except `/health`:

**`GET /capabilities`** — reads every artifact under `evidence/artifacts/` via
`loadCapabilityCatalog()` and returns, per capability:

```json
{
  "id": "open-sub-account",
  "name": "Open Sub-Account",
  "description": "...",
  "version": "1",
  "fingerprint": "...",
  "approvalState": "draft",
  "confidence": { "label": "unproven", "...": "..." },
  "inputParams": [
    { "name": "username", "type": "string", "required": true, "sensitive": false },
    { "name": "password", "type": "string", "required": true, "sensitive": true },
    { "name": "memberId", "type": "string", "required": true, "sensitive": false },
    { "name": "accountType", "type": "string", "required": true, "sensitive": false },
    { "name": "initialDeposit", "type": "string", "required": true, "sensitive": false }
  ],
  "outputSchema": [ "..." ]
}
```

`inputParams`/`outputSchema` come straight from the artifact's own typed schema
(`src/artifact/schema.ts`'s `InputParamSchema`/`OutputFieldSchema`) — nothing is re-derived
or guessed, the contract an agent sees is the literal artifact contract.

**`POST /capabilities/:id/invoke`** — body shape:

```typescript
{ params: Record<string, string>; allowRisky?: boolean; tenantId?: string }
```

Handling, in order:
1. Look up the artifact by id (`findCapabilityById`) — 404 if not found, before anything
   else runs.
2. Resolve an optional `tenantId` into the tenant-overridden artifact
   (`resolveEffectiveArtifact` — see "The path-traversal bug" below) — 400 on a bad
   `tenantId` or a missing/mismatched override file.
3. Register sensitive param names/values with the `EvidenceLogger` (`addSensitiveKeys`/
   `addSensitiveValue`) *before* logging anything, so a password never reaches the evidence
   log or a screenshot's alt text in the clear.
4. Load/refresh this artifact's registry entry, compute its drift-adjusted confidence label,
   and compute `effectiveAllowRisky` — the same gate `src/replay/execution-policy.ts` gives
   the CLI: a caller's `allowRisky: true` only actually takes effect once this exact artifact
   content (base or tenant-overridden) is `approved` *and* its confidence hasn't degraded to
   `low`/`unproven`.
5. Run `replay({ artifact, params, surface, policy, logger, runId, allowRisky })` — a fresh
   headless `PlaywrightSurface`, not the headed one `run-agent`/`replay` use interactively;
   this path stands in for an unattended agent calling into production.
6. Map the result to an HTTP status via `statusCodeFor()` (`src/api/status.ts`):
   `success`/`business_outcome` → 200, `failure` → 422 — so a caller can `if (response.ok)`
   and still branch on `status` for the success-vs-business-outcome distinction it actually
   needs (see [`06-deterministic-replay.md`](06-deterministic-replay.md) for why that
   three-way split matters).
7. Record the outcome into the same registry file the CLI writes to, so an API-invoked run
   shows up in `npm run drift-report` and the dashboard exactly like a CLI-invoked one — not
   special-cased, just a consequence of sharing the engine.

### Why authentication belongs here, briefly

`app.use(requireApiKey("CAPABILITY_API_KEY"))` gates every route except `/health` (which
discloses nothing beyond "the process is up" — needed unauthenticated for container
orchestrators/uptime checks). The check (`src/http/api-key-auth.ts`) accepts a bearer token
or an `X-API-Key` header, compares it with a SHA-256-then-`crypto.timingSafeEqual` comparison
(so response timing can't leak the secret), and — critically — the server **refuses to
start at all** if `CAPABILITY_API_KEY` isn't set, rather than silently running
unauthenticated. `/invoke` also carries its own rate limit (20/minute), independent of read
traffic to `/capabilities`, since invocation can trigger a real action and shouldn't share a
budget with a well-behaved discovery caller. Full design and why this is a single shared
secret per surface rather than per-operator identity lives in
[`19-security-and-authentication.md`](19-security-and-authentication.md) and `SECURITY.md`.

### The real path-traversal bug, as a concrete lesson

`src/api/tenant-resolution.ts`'s `resolveEffectiveArtifact()` takes an optional `tenantId`
and, historically, built a file path with a bare
`path.join(overridesDir, \`${tenantId}.json\`)`. That `tenantId` reaches this function
straight from an HTTP request body — or, via the conversational front end (see
[`15-conversational-frontend.md`](15-conversational-frontend.md)), from a model's own output
— i.e. from an **untrusted caller**, not an operator typing a CLI flag. Nothing stopped a
`tenantId` of `"../../../../etc/passwd"` from resolving outside
`config/tenant-overrides/` entirely and reading an arbitrary `.json`-suffixed file the
process could access.

The fix, still in the file today:

```typescript
const SAFE_TENANT_ID = /^[a-zA-Z0-9_-]+$/;
// ...
if (!SAFE_TENANT_ID.test(tenantId)) {
  throw new Error(`Invalid tenantId "${tenantId}" -- must match ${SAFE_TENANT_ID}.`);
}
```

validated **before** any path is built or any filesystem call is made — restricting
`tenantId` to the same charset real tenant filenames on disk actually use closes the
traversal off entirely, rather than trying to sanitize or escape the value afterward.
`src/api/tenant-resolution.test.ts` asserts the *validation* error specifically (not a
coincidental file-not-found), to prove the check runs first. It was found by re-reading every
place an HTTP request body value reaches `fs`/`path` during a dedicated hardening pass, not
by a fuzzer or an external report — worth naming plainly, the same reasoning
`REPORT.md` gives for listing adversarial-review findings explicitly rather than folding them
silently into a diff.

The function also enforces one more integrity check after loading the file: the override's
own declared `tenantId` field must match the filename it was requested by, or it's refused —
the same "fail loud on a mismatch" posture `applyTenantOverride`'s `vendorProductId` check
already has.

### Where

- `src/api/server.ts` — both routes, the express app, auth/rate-limit wiring.
- `src/api/status.ts` — `statusCodeFor()`, the three-way `ReplayResult` → HTTP status map.
- `src/api/tenant-resolution.ts` — `resolveEffectiveArtifact()` and `SAFE_TENANT_ID`, the
  fixed path-traversal check.
- `src/cli/agent-invoke-demo.ts` — the demo caller that plays "the agent-facing product,"
  discovering then invoking.
- `src/http/api-key-auth.ts` — `requireApiKey()`, the shared auth middleware also used by the
  dashboard's Basic-auth sibling.
- `src/replay/execution-policy.ts` — `effectiveAllowRisky()`, the confidence circuit breaker
  this route defers to, identical to the CLI's.
- `src/artifact/catalog.ts` — `loadCapabilityCatalog()`/`findCapabilityById()`, reading
  artifacts + registry state off disk for `/capabilities`.

### A worked technical example

```bash
curl -s -X POST http://localhost:4700/capabilities/open-sub-account/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CAPABILITY_API_KEY" \
  -d '{"params":{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"},"allowRisky":true}'
```

Against an approved, healthy-confidence artifact, this returns HTTP 200 with a body shaped
like `ReplaySuccessResult`:

```json
{ "status": "success", "runId": "replay-2026-08-25T18-36-01-086Z", "outputs": { "confirmationNumber": "..." } }
```

Against a `draft` artifact, the same request returns HTTP 422 with a `ReplayFailureResult`
whose `observed` field says something like "no confirmation given" — the exact string
`agent-invoke-demo.ts`'s `explainDeclinedRisky()` pattern-matches on to print a human-readable
explanation of *why* (draft vs. approved-but-confidence-capped are different, real reasons
for the same decline).

### Edge cases & failure modes

- **Unknown capability id** — 404, no evidence run created (no artifact context to log
  against yet).
- **Bad or missing `tenantId`** — 400, before a logger/browser/registry entry is created.
- **Missing/invalid params** — the `replay()` call itself throws a `Missing required input
  params`/`Invalid input params` error, caught and mapped to 400, distinct from any other
  runtime error (which maps to 500).
- **Risky step, artifact not approved (or approved but confidence-capped)** — declined
  automatically, 422, `observed` includes "no confirmation given."
- **Risky step, artifact approved and healthy** — proceeds without a human present, since
  `allowRisky` was both requested and earned.
- **A sensitive param value (e.g. a password)** — registered with the evidence logger before
  any logging happens, so it's redacted in the run's JSONL log and never appears in a
  screenshot's captured text.
- **Two versions of the same capability id on disk** — not handled distinctly; whichever
  on-disk artifact matches wins. A known, disclosed gap for a real fleet deployment, not a
  scenario this repo's own tooling produces today.
- **No queueing** — a synchronous, Playwright-backed HTTP handler with a request-scoped rate
  limit is deliberately the right amount of infrastructure here, per the brief's own "don't
  build scaling infrastructure you don't need" instruction — not a production concurrency
  model.

## Related docs

- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the exact engine this API
  wraps
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — the approval/confidence
  gate `effectiveAllowRisky` enforces here too
- [`15-conversational-frontend.md`](15-conversational-frontend.md) — the natural-language
  caller built on top of this same API
- [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md) — why this
  surface never wires up `onRiskyStep`
- [`19-security-and-authentication.md`](19-security-and-authentication.md) — full auth design
- [`REPORT.md`](../REPORT.md) — "Agent-facing capability interface" section
- [`SECURITY.md`](../SECURITY.md) — authentication and the path-traversal fix
