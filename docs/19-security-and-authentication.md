# Security and Authentication

## In one sentence

Secrets live only in a git-ignored `.env` file and are never hard-coded, the two HTTP
surfaces that expose real state (the capability API and the dashboard) each require a
secret checked in constant time and refuse to even start without one, and a real
path-traversal bug found during this build is fixed at the boundary where an untrusted
`tenantId` first touches the filesystem — while a few things (per-user identity, an audit
trail of *who* approved what) are deliberately left out and disclosed, not accidentally
missing.

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
- What this building's front-door system does **not** yet do is keep a logbook of exactly
  *which named employee* badged in each visitor, or *who specifically* approved letting a
  particular delivery through. It tracks *that* someone was let in and *when*, not *who*
  they were. That's a real, known gap — not a secret one — and it's written down plainly
  rather than glossed over.

### What this looks like in the actual project

This project has exactly that shape:

- **Secrets** (`GEMINI_API_KEY`, `CAPABILITY_API_KEY`, `DASHBOARD_PASSWORD`) live in a
  file called `.env`, which is listed in `.gitignore` so it can never accidentally get
  committed to the project's history or pushed to GitHub. `.env.example` shows what
  variables exist, with placeholder text like `generate-a-random-value-do-not-reuse-this-placeholder`
  — never a real value. The one secret that *is* checked into the source code,
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
- **Fails locked, loudly.** If you try to start the dashboard or the capability API without
  ever setting `DASHBOARD_PASSWORD` / `CAPABILITY_API_KEY` in `.env`, the program refuses
  to start at all and prints an error telling you exactly what to fix. It does not fall
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
- **What's honestly missing.** This system does not track *which specific person* clicked
  "yes" on a risky-action confirmation, or *which specific person* approved an artifact for
  unattended use. It records *that* a decision was made and *when* — not *who* made it.
  That's a real limitation for a real deployment with many different human operators, and
  it's written down as a limitation rather than pretended away.

### "What happens if...?"

| Situation | What happens |
|---|---|
| You start the dashboard without ever setting `DASHBOARD_PASSWORD` in `.env` | The server throws an error immediately and never starts listening — nobody, including you, gets in. |
| A script calls the capability API with the wrong API key | It gets back `401 Unauthorized`, in the same amount of time whether the key was close-but-wrong or completely wrong. |
| A script calls the capability API with no key at all | Same `401` — every route except `/health` requires it. |
| Someone tries to check "is the service alive?" without a password (e.g. an automated uptime monitor) | `GET /health` works with no credential on every one of the three services, on purpose — it reveals nothing beyond "the process is running." |
| A caller sends a `tenantId` designed to escape the tenant-config folder (like `"../../secrets"`) | Rejected before any file is touched — `tenantId` must match a strict allowed character pattern first. |
| Someone asks "who specifically approved this risky withdrawal action last Tuesday?" | The system can tell you *that* a human approved it and *when* — it cannot tell you which named person, because that's not tracked yet; the compliance report says so explicitly rather than guessing. |
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

Two auth mechanisms, one shared comparison primitive, all in `src/http/api-key-auth.ts`:

- **`requireApiKey(envVarName)`** — Express middleware factory. Reads the expected secret
  from `process.env[envVarName]` at setup time (throwing if unset — see "fail closed"
  below). The returned middleware accepts either `Authorization: Bearer <key>` or
  `X-API-Key: <key>` via `extractBearerToken()`, and compares the provided value against
  the expected key with `timingSafeEqual()`. Used on every route of the capability API
  (`src/api/server.ts`) except `/health`.
- **`requireBasicAuth(envVarName)`** — same shape, but parses an HTTP `Basic` header
  (`Authorization: Basic <base64(username:password)>`), extracts only the password half
  (the username is unchecked — "operator" is conventional, not verified), and compares it
  the same way. On failure it sets `WWW-Authenticate: Basic realm="Capability Dashboard"`
  so the browser itself pops up a native login prompt. Used on the dashboard
  (`src/dashboard/server.ts`).
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

**Fail closed and loud** is enforced at middleware-construction time, not per-request:

```ts
export function requireApiKey(envVarName: string) {
  const expectedKey = process.env[envVarName];
  if (!expectedKey) {
    throw new Error(
      `${envVarName} is not set. This server refuses to start unauthenticated -- set ${envVarName} in your .env (see .env.example).`
    );
  }
  return (req, res, next) => { /* ... */ };
}
```

Because `requireApiKey("CAPABILITY_API_KEY")` is called once, while the Express app is
being wired together at module load, an unset env var throws *before* `app.listen()` is
ever reached — the process crashes on startup rather than silently serving every request
unauthenticated. This is the same design in `Dockerfile.capability-api`'s and
`Dockerfile.dashboard`'s comments: if you forget to supply the env var via `docker run -e`
or Compose's `env_file: .env`, the container crash-loops instead of quietly running an
open door.

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

- **`CAPABILITY_API_KEY`/`DASHBOARD_PASSWORD` unset** — process throws at startup, never
  listens. Verified by the same check both natively and in the Dockerfiles' own comments.
- **Correct key, wrong scheme** (e.g. sending a bearer token to the Basic-auth dashboard, or
  vice versa) — rejected the same as a wrong secret; the two middlewares only understand
  their own header format.
- **`/health` called with no credential** — succeeds on all three services, by design, so
  container orchestrators/uptime checks work without provisioning a credential just to ask
  "are you alive."
- **A request-body value (`tenantId`) crossing into a filesystem path** — validated against
  an allowed character set before path construction; see "How" above.
- **An access log accidentally becoming a secret-leak channel** — prevented structurally by
  only ever logging method/path/status/duration, never headers or bodies.
- **Multiple human operators sharing one dashboard password** — by design, not a bug: there
  is no per-user identity in this system today. A real multi-operator deployment needs an
  identity provider layered on top of this, not instead of it — see `SECURITY.md`
  "What's deliberately not hardened."

## Related docs

- [`01-system-design.md`](01-system-design.md) — where the capability API and dashboard sit in the overall architecture
- [`14-capability-api.md`](14-capability-api.md) — the full path-traversal story and the API's request/response shapes
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the allowlist and risky-action checks that sit behind these auth layers
- [`22-docker-and-containers.md`](22-docker-and-containers.md) — how secrets reach containers without being baked into images
- [`../SECURITY.md`](../SECURITY.md) — the full consolidated threat model this doc summarizes
- [`../REPORT.md`](../REPORT.md) — §6 "Safety" and §8 for the original design write-up
