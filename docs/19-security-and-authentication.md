# Security and Authentication

## In one sentence

Secrets live only in a git-ignored `.env` file and are never hard-coded, the two HTTP
surfaces that expose real state (the capability API and the dashboard) each resolve a
presented credential to a specific NAMED operator (not just a binary valid/invalid) checked
in constant time and refuse to even start without one, and a real path-traversal bug found
during this build is fixed at the boundary where an untrusted `tenantId` first touches the
filesystem — while one thing (an audit trail of *who approved a specific risky action*, as
opposed to *who submitted the run*) is still deliberately left out and disclosed, not
accidentally missing.

---

## Part 1 — For everyone: what keeps this system safe to run?

### The analogy

Picture an office building with one badge reader at the front door. It works like this:

- The reader **fails locked**, not unlocked — if the reader itself has no batteries
  installed (nobody configured a badge code), the door doesn't quietly let everyone in; it
  refuses to open for anyone, including people with real badges, until someone fixes the
  reader.
- The guard checks a badge by comparing it to the master list **without ever revealing how
  close a wrong badge came to being right**. A badge that's wrong in the first digit gets
  rejected in exactly the same amount of time as a badge that's wrong only in the last
  digit — otherwise a patient attacker could learn the real badge number one digit at a
  time just by timing how long each rejection took.
- There are actually **two different front doors** in this building, and they use two
  different kinds of check on purpose. One door is for delivery robots that already carry a
  keycard programmed into them (they don't need a human-friendly login screen — they just
  present the card). The other door is for human visitors, who don't carry a keycard at
  all and expect the reader to just ask them, out loud, for a password.
- The reader now keeps a real logbook of exactly *which named badge* came through, not just
  "a valid badge came through" — every badge in the master list belongs to one specific,
  named person, and the logbook says which one. What it still does **not** do is note *who
  specifically* approved letting a particular delivery through once they were already
  inside — it can tell you which named employee badged in, but not which of them clicked
  "approve" on a specific delivery. That narrower gap is real and known, not secret, and
  it's written down plainly rather than glossed over.

### What this looks like in the actual project

This project has exactly that shape:

- **Secrets** (`GEMINI_API_KEY`, `CAPABILITY_API_KEY`, `DASHBOARD_PASSWORD`) live in a
  file called `.env`, which is listed in `.gitignore` so it can never accidentally get
  committed to the project's history or pushed to GitHub. `.env.example` shows what
  variables exist, with placeholder text like `generate-a-random-value-do-not-reuse-this-placeholder`
  — never a real value. `config/operators.json`, by contrast, IS checked into the repo --
  it only ever holds env var *names* to look up, never a secret value itself, the same
  pattern the allowlist config already uses. The one secret that *is* checked into the
  source code,
  `mock-bank`'s session secret, is deliberately named right in the code
  `"mock-bank-dev-secret-not-sensitive"` — because `mock-bank` is the fake bank app this
  system automates, not the system being secured, the same way a bank's real teller
  software isn't "secured" by the company automating it.
- **Two front doors, two different checks.** The capability API (the one an AI agent or a
  script calls, e.g. `POST /capabilities/open-sub-account/invoke`) expects a secret key in
  a request header — that's the "delivery robot with a keycard" door. The dashboard (the
  one a human opens directly in a web browser at `http://localhost:4600`) uses the
  familiar browser username/password popup — that's the "human visitor" door. Different
  callers, different mechanisms, on purpose.
- **Named operators, not one shared secret.** `config/operators.json` lists who's actually
  allowed through each door — a badge (API key) or a username+password (dashboard), each
  belonging to a specific named entry. A presented credential resolves to exactly one of
  them; that name then shows up in this run's evidence log and, if you generate one, the
  compliance report. Adding a second real person is one new list entry and one new env
  var holding their own secret — no code changes.
- **Fails locked, loudly.** If you try to start the dashboard or the capability API without
  any configured operator actually having a usable credential, the program refuses to
  start at all and prints an error telling you exactly what to fix. It does not fall
  back to "well, I guess nobody needs a password today."
- **Timing-safe comparison.** When you type a password into the dashboard's login popup,
  the code doesn't just compare your password to the real one character-by-character and
  stop as soon as it finds a mismatch — that would let an attacker measure tiny timing
  differences and guess the password one character at a time. Instead it hashes both your
  guess and the real password first, then compares the hashes in a way specifically
  designed to take the same amount of time no matter what.
- **A real bug, found and fixed.** Early in this project, the capability API accepted a
  `tenantId` value (e.g. `"northgate-cu"`) from an incoming request and used it directly to
  build a file path on disk. Nobody had checked that `tenantId` couldn't contain something
  like `"../../../../etc/passwd"` — which, if unblocked, would have let a malicious caller
  read files far outside the folder they were supposed to be limited to. This is fixed now
  (see [`14-capability-api.md`](14-capability-api.md) for the full technical story); the
  short version lives here because it's a security decision, not just an API detail.
- **What's still honestly missing.** This system now tracks *which named operator*
  submitted a given run — but it still does not track *which specific person* clicked "yes"
  on one particular risky-action confirmation inside that run, or *which specific person*
  approved an artifact for unattended use in the first place. It records *that* a decision
  was made and *when*, and now also *whose credential started the run* — but not *who,
  specifically, approved the one risky step in the middle of it*. That's a real, narrower
  limitation for a real deployment with many different human operators, and it's written
  down as a limitation rather than pretended away.

### "What happens if...?"

| Situation | What happens |
|---|---|
| You start the dashboard without any configured operator having a usable password | The server throws an error immediately and never starts listening — nobody, including you, gets in. |
| A script calls the capability API with the wrong API key | It gets back `401 Unauthorized`, in the same amount of time whether the key was close-but-wrong or completely wrong. |
| A script calls the capability API with no key at all | Same `401` — every route except `/health` requires it. |
| Someone logs into the dashboard with operator "bob"'s username but operator "alice"'s (otherwise valid) password | Rejected — the username is looked up first, and that operator's own password is what's actually compared. |
| Someone tries to check "is the service alive?" without a password (e.g. an automated uptime monitor) | `GET /health` works with no credential on every one of the three services, on purpose — it reveals nothing beyond "the process is running." |
| A caller sends a `tenantId` designed to escape the tenant-config folder (like `"../../secrets"`) | Rejected before any file is touched — `tenantId` must match a strict allowed character pattern first. |
| Someone asks "which operator's credential submitted this capability-API run last Tuesday?" | Answerable now, from the run's own evidence log / the compliance report's "Operator" line, for any run that went through the capability API. |
| Someone asks "who specifically approved this risky withdrawal action, not just which credential started the run?" | Still not tracked — the capability API has no interactive confirmation path at all (a risky step there is auto-declined, not attributably approved by anyone), and this system doesn't yet record which of several operators sharing CLI access clicked "yes" on an attended prompt. The compliance report says so explicitly rather than guessing. |
| The discovery goal text itself contains a password (e.g. `"sign on with password 'demo_password'"`) | The password is masked in evidence logs anyway — a separate redaction mechanism catches known secret *values*, not just fields named "password," specifically because this exact case leaked once during development. |

---

## Part 2 — For engineers: why, what, how, where

### Why

A real deployment of this system would sit between an AI agent (or a human operator) and a
bank's actual back-office software — so it has to answer "who's allowed to call this, and
how do we know they are who they claim" without over-building an identity system this
project's actual size doesn't justify. The brief's own "don't build infrastructure you
don't need" principle applies here exactly as it does everywhere else: there is exactly one
caller class per HTTP surface (an agent/script calling the capability API; a human operator
opening the dashboard), so a single shared secret per surface, checked correctly, is
proportionate — a JWT/OAuth/per-user identity layer would be solving a problem this system
doesn't have yet, at real implementation cost.

### What

Two auth mechanisms, one shared comparison primitive, and (as of the per-operator identity
feature) a small named-operator registry underneath both, all in `src/http/api-key-auth.ts`
and `src/http/operator-registry.ts`:

- **`loadOperatorRegistry(config?)`** (`operator-registry.ts`) — reads `config/operators.json`
  (a committed list of `{ id, apiKeyEnvVar?, dashboardUsername?, dashboardPasswordEnvVar? }`
  entries, pointing at env var NAMES, never a secret value) and resolves each entry's env
  vars to actual values. An operator whose relevant env var is unset simply has no usable
  credential for that mechanism (`undefined`, not an empty string).
- **`requireApiKey(config?)`** — Express middleware factory (default arg: the real
  `config/operators.json`; tests pass entries directly). At setup time it loads every
  operator with a usable API key (throwing if none exist — see "fail closed" below). The
  returned middleware accepts either `Authorization: Bearer <key>` or `X-API-Key: <key>` via
  `extractBearerToken()`, finds which configured operator's key matches via
  `timingSafeEqual()`, and sets `req.operatorId` to that operator's id before calling
  `next()`. Used on every route of the capability API (`src/api/server.ts`) except
  `/health`.
- **`requireBasicAuth(config?)`** — same shape, but parses an HTTP `Basic` header
  (`Authorization: Basic <base64(username:password)>`). The username now MATTERS: it's
  looked up against the registry's configured `dashboardUsername`s, and only then is that
  specific operator's password compared with `timingSafeEqual()`. On failure it sets
  `WWW-Authenticate: Basic realm="Capability Dashboard"` so the browser itself pops up a
  native login prompt. Used on the dashboard (`src/dashboard/server.ts`).
- **`timingSafeEqual(a, b)`** (private helper, not exported) — hashes both `a` and `b` with
  SHA-256 to a fixed 32-byte digest *before* calling Node's `crypto.timingSafeEqual()`.

### How

```ts
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const digestA = crypto.createHash("sha256").update(bufA).digest();
  const digestB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}
```

The hash-first step matters for a specific reason: `crypto.timingSafeEqual` **throws** if
its two buffers have different lengths, rather than returning `false`. If this code passed
the raw candidate and expected secret straight in, it would need a length check first —
and that length check would itself be a timing/behavioral leak (an attacker could learn the
real secret's length by noticing which inputs throw vs. return false). Hashing both sides
to the same fixed-length digest first removes the length-mismatch case entirely, so the
comparison that follows is constant-time regardless of what the caller sent.

**Disclosed, accepted exception to that same care:** `requireBasicAuth`'s username lookup
happens with plain `===` *before* the timing-safe password compare, so a nonexistent
username fails a step earlier than an existing one — a theoretical username-enumeration
signal. Not hardened against; matches this system's existing "not a full identity provider"
posture rather than adding a constant-time username scan for a two-operator demo registry.

**Fail closed and loud** is enforced at middleware-construction time, not per-request:

```ts
export function requireApiKey(config: string | OperatorConfigEntry[] = DEFAULT_OPERATOR_CONFIG_PATH) {
  const operators = loadOperatorRegistry(config).filter((op) => !!op.apiKey);
  if (operators.length === 0) {
    throw new Error("No operator in the registry has a usable API key -- ...");
  }
  return (req, res, next) => { /* find the matching operator, set req.operatorId, next() */ };
}
```

Because `requireApiKey()` is called once, while the Express app is being wired together at
module load, a registry with no usable credential at all throws *before* `app.listen()` is
ever reached — the process crashes on startup rather than silently serving every request
unauthenticated. This is the same design in `Dockerfile.capability-api`'s and
`Dockerfile.dashboard`'s comments: if you forget to supply the env var via `docker run -e`
or Compose's `env_file: .env`, the container crash-loops instead of quietly running an
open door. The default `local-operator` entry in `config/operators.json` points at the same
`CAPABILITY_API_KEY`/`DASHBOARD_PASSWORD` env vars that already existed, so this is a
behavior-preserving change for anyone with an existing `.env` — adding a second, named human
operator is one new JSON entry + one new env var, no code change.

**Where the resolved identity actually goes.** `req.operatorId` (set above) is read at
exactly one call site in `src/api/server.ts`'s `/invoke` handler, added to the same
`logger.log({ phase: "start", detail: {...} })` call that already records fingerprint/
tenantId/approvalState — no changes to the evidence logger itself. From there,
`src/evidence/audit-report.ts`'s `buildRunAuditEntry` reads it out of that same `start`
event the same way it already reads `fingerprint`, and `renderAuditReportMarkdown` prints an
`- Operator: <id>` line when present. `src/http/request-log.ts` also logs it per-request
(dropped when `undefined`, e.g. on `/health`), so both the capability API's and the
dashboard's stdout access logs get a per-request "who" for free, without any dashboard
rendering-code changes.

Request logging (`src/http/request-log.ts`) is deliberately shape-only:

```ts
console.log(JSON.stringify({
  service: serviceName, method: req.method, path: req.path,
  status: res.statusCode, durationMs: ..., timestamp: ...,
}));
```

No headers, no bodies — specifically so the access log itself can never become a second,
unredacted channel for the exact credentials `api-key-auth.ts` is checking and
`src/guardrails/redaction.ts` is masking. An `Authorization: Bearer <key>` header hitting a
naive "log everything" middleware would defeat the whole point.

**The path-traversal fix** (`src/api/tenant-resolution.ts`): the original code built
`config/tenant-overrides/<tenantId>.json` directly from the request's `tenantId` field. The
fix validates `tenantId` against `^[a-zA-Z0-9_-]+$` — the same character set real tenant
filenames actually use — *before* any path is constructed, not after, closing off values
like `"../../../../etc/passwd"` before they ever reach `fs`/`path`. Full detail, including
how this was found (auditing every place a request-body value reaches the filesystem,
rather than a scanner) is in [`14-capability-api.md`](14-capability-api.md) and
`REPORT.md` §8.

### Worked technical example

```bash
curl -s -X POST http://localhost:4700/capabilities/open-sub-account/invoke \
  -H "Content-Type: application/json" \
  -d '{"params": {"memberId": "10002"}}'
```

```json
{"error":"Unauthorized. Provide a valid API key via 'Authorization: Bearer <key>' or 'X-API-Key'."}
```

with the correct key supplied instead:

```bash
curl -s -X POST http://localhost:4700/capabilities/open-sub-account/invoke \
  -H "Authorization: Bearer $CAPABILITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"params": {"memberId": "10002"}}'
```

...proceeds to the real guardrail-checked invocation logic instead of a 401.

### Edge cases & failure modes

- **No operator in `config/operators.json` has a usable credential at all** (every
  referenced env var unset) — process throws at startup, never listens. Verified by the
  same check both natively and in the Dockerfiles' own comments.
- **Correct key, wrong scheme** (e.g. sending a bearer token to the Basic-auth dashboard, or
  vice versa) — rejected the same as a wrong secret; the two middlewares only understand
  their own header format.
- **A dashboard username that matches no configured operator, even with a correct password
  for a DIFFERENT operator** — rejected. Username lookup happens before the password
  compare now, unlike the old single-shared-secret behavior where any username worked.
- **`/health` called with no credential** — succeeds on all three services, by design, so
  container orchestrators/uptime checks work without provisioning a credential just to ask
  "are you alive."
- **A request-body value (`tenantId`) crossing into a filesystem path** — validated against
  an allowed character set before path construction; see "How" above.
- **An access log accidentally becoming a secret-leak channel** — prevented structurally by
  only ever logging method/path/status/duration/`operatorId`, never headers or bodies.
- **Every configured operator has the same capabilities (no roles)**, and **no interactive
  confirmation path exists on the capability API at all**, so a risky step there is
  auto-declined rather than attributably approved by a specific person — knowing *which
  operator submitted a run* is not the same as knowing *who approved a specific risky
  action inside it*. A real multi-operator deployment would still want a full identity
  provider (roles, session expiry, per-approver audit) layered on top of this named-operator
  registry, not instead of it — see `SECURITY.md` "What's deliberately not hardened."

## Related docs

- [`01-system-design.md`](01-system-design.md) — where the capability API and dashboard sit in the overall architecture
- [`14-capability-api.md`](14-capability-api.md) — the full path-traversal story and the API's request/response shapes
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the allowlist and risky-action checks that sit behind these auth layers
- [`22-docker-and-containers.md`](22-docker-and-containers.md) — how secrets reach containers without being baked into images
- [`../SECURITY.md`](../SECURITY.md) — the full consolidated threat model this doc summarizes
- [`../REPORT.md`](../REPORT.md) — §6 "Safety" and §8 for the original design write-up
