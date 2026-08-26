# Guardrails and Safety

## In one sentence

Before the automation is allowed to do anything — during discovery *or* replay, with an AI
deciding the action or a recorded recipe dictating it — one shared piece of code checks it
against an explicit list of "what's actually permitted here," treats anything hard-to-undo with
extra suspicion, and everything written down about what happened has secrets scrubbed out before
it ever touches disk.

---

## Part 1 — For everyone: the compliance officer analogy

### The real-world analogy

Picture a compliance officer standing next to every action an employee (or, here, an automated
system) is about to take. This officer doesn't work from "does this seem like a reasonable thing
to do" — they work from a written list: *here are the specific things you're allowed to do, and
here's specifically what's required before you do them.* Anything not explicitly on the list is
forbidden, full stop, not "probably fine." And the officer applies extra scrutiny to anything
that can't be undone — actually opening an account, actually moving money — while things that
leave no lasting trace if they're wrong, like just looking something up, get waved through more
readily.

That officer is this system's **guardrails** layer: `src/guardrails/policy.ts`,
`src/guardrails/allowlist.ts`, and `src/guardrails/redaction.ts`. Whether the AI (during
discovery) or the recorded recipe (during replay) is the one about to act, it's the *same*
officer checking it — there is no separate, less-strict version of this check for "the recipe has
been run a thousand times before, surely it's fine by now."

### A concrete walkthrough

The demo capability, opening a sub-account, involves a handful of pages: sign on, search for a
member, look at their account, open a new sub-account, land on a confirmation screen. The
allowlist (`config/allowlist.json`) says exactly which of these are permitted, and which of those
are "safe" (just looking) versus "risky" (actually changing something):

```json
{
  "allowedBaseUrls": ["http://localhost:4000", "http://localhost:4100"],
  "routes": [
    { "pattern": "/login", "methods": ["GET", "POST"], "risk": "safe" },
    { "pattern": "/members/:id", "methods": ["GET"], "risk": "safe" },
    { "pattern": "/members/:id/sub-accounts/new", "methods": ["GET"], "risk": "safe" },
    { "pattern": "/members/:id/sub-accounts", "methods": ["POST"], "risk": "risky" },
    { "pattern": "/members/:id/sub-accounts/:subId/confirm", "methods": ["GET"], "risk": "safe" }
  ]
}
```

Notice what this *isn't*: it doesn't say "clicking is safe, typing is safe, but the action called
`openSubAccount` is risky." It says which literal web addresses and which literal "GET, just
reading" versus "POST, actually submitting" combinations are allowed — because that's what
actually determines whether something changed on the bank's server, regardless of what a button
happened to be labeled.

So, concretely, when the automation is about to submit the "Open Sub-Account" form for member
`10001`, this is really a `POST /members/10001/sub-accounts`. That matches the allowlist, and it's
marked `risky`. Because it's risky, the system doesn't just do it — it stops and asks:

```
=== RISKY ACTION REQUIRES CONFIRMATION ===
POST /members/10001/sub-accounts is classified risky and requires confirmation.
Type 'yes' to proceed, anything else to decline:
```

A human has to type `yes`. Compare that to looking up member `10001` in the first place — that's
a `GET /members/10001`, marked `safe`, and it just happens with no prompt at all, because looking
something up can't hurt anyone even if it turns out to be the wrong member.

### Why not just check "does the address start with the right thing"?

An earlier, simpler version of this check was: "does the target address literally start with
`http://localhost:4000`?" That sounds reasonable and is actually a real security hole. Consider
this address:

```
http://localhost:4000.evil.example.com/login
```

That literally *starts with* the string `http://localhost:4000` — but it is a completely
different website (`evil.example.com`), not the bank's app at all. A check based on "starts with
the right text" would wave this straight through. The same trick works with:

```
http://localhost:4000@evil.com/login
```

— which, per how web addresses are actually structured, means "log in as user `localhost:4000` on
the website `evil.com`," not "go to `localhost:4000`" at all. Both of these defeat a naive prefix
check while looking, to a human skimming quickly, like they mention the right address. The fix is
to actually parse the address properly and compare where it *really* points (its "origin" — the
real website behind it), not what string of characters it happens to start with.

### Why does "I can't tell where this goes" sometimes mean "block it" and sometimes mean "let it fail on its own"?

This is subtle, and getting it wrong caused a real bug during development. Sometimes the
automation tries to click something and the system genuinely can't figure out in advance where
that click will lead (no ordinary link, no ordinary form — something JavaScript-driven). The safe
thing here is to refuse and ask a human, because that's exactly the kind of hidden write action
this whole guardrail system exists to catch.

But there's a *different* situation that looks similar on the surface: the button or link simply
isn't there at all on the current page. For example, on a page telling an operator "Access
denied" for a restricted member, there's no "Open Sub-Account" link to click, because the bank's
own software correctly didn't render it for someone without permission. The very first version of
this system treated "can't figure out where this goes" and "this doesn't even exist on the page"
as the same thing — blocked — which meant a completely normal, expected "you're not allowed to
see this" business answer got mis-reported as if it were a security violation. The fix was to
tell these two situations apart: "this doesn't exist" is left alone to fail on its own (and get
correctly reported as the `permission_denied` business outcome it actually is), while "this
exists but I can't tell where it leads" is the one that gets refused.

### "What happens if...?"

| Situation | What happens |
|---|---|
| The automation is about to submit a form that actually changes something (open a sub-account) | Classified `risky` — requires explicit confirmation ("yes") every time, unless the recipe has been separately reviewed and approved for unattended use. |
| The automation is just looking something up (searching for a member, viewing their page) | Classified `safe` — happens immediately, no prompt. |
| The target address is `http://localhost:4000.evil.example.com/login` | Blocked. The real destination (`evil.example.com`) doesn't match any allowed address, once compared properly instead of by text prefix. |
| The target address has a username baked into it (`http://localhost:4000@evil.com/...`) | Blocked outright, before even checking the allowlist — a web address with login credentials embedded in it is never something this system should be navigating to. |
| A click's destination can't be figured out in advance at all (no ordinary link or form behind it) | Refused, fails closed — treated as exactly the kind of hidden write this system exists to catch. |
| A button that would normally be there just isn't rendered on this particular page (e.g. permission denied) | Left alone — allowed to simply fail on its own and get correctly reported as whatever normal business answer that page actually represents. |
| A password is typed into the discovery goal description itself, before the system has ever "seen" a password field | Still gets scrubbed from every log — the system is told in advance "this exact value is a secret," and masks it wherever it shows up, not just inside fields literally named "password." |
| A short, unrelated 3- or 4-digit number happens to also appear somewhere in a log entry | Not masked — masking every short number that coincidentally matches part of a secret would end up hiding harmless account numbers and amounts too. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Three separate design pressures, each addressed by one mechanism:

1. **"Allowed" has to be defined by what actually changes state on the server, not by how a
   button happens to be labeled or what action-type an AI decided to call.** A route (path +
   HTTP method) is the only thing that reliably corresponds to a real effect. Classifying by
   action type (e.g. "clicks are always safe") would misclassify a JS-driven write disguised as a
   click.
2. **Anything not explicitly permitted must fail closed, not open.** A brand-new bank/credit
   union onboarding onto this system should start from "nothing is allowed" and have someone
   deliberately add routes, not start from "anything goes until we notice a problem."
3. **Regulated financial data must never be persisted in the clear** (per the brief, Section
   3.4) — not in evidence logs, not in serialized artifacts — because those are exactly the
   artifacts a real audit or a real incident review would pull up later.

### What

**Guardrail check.** `GuardrailsPolicy.authorize(surface, action)` (`src/guardrails/policy.ts`)
returns:

```ts
export interface AuthorizationResult {
  allowed: boolean;
  risk: RiskLevel; // "safe" | "risky"
  route?: string;
  method?: "GET" | "POST";
  reason?: string;
}
```

**Allowlist.** `config/allowlist.json` → `AllowlistConfig`:

```ts
export interface RouteRule {
  pattern: string;       // e.g. "/members/:id/sub-accounts"
  methods: HttpMethod[]; // "GET" | "POST"
  risk: RiskLevel;       // "safe" | "risky"
}
export interface AllowlistConfig {
  allowedBaseUrls: string[];
  routes: RouteRule[];
}
```

**Redaction.** `redact(value, options)` (`src/guardrails/redaction.ts`) deep-masks a value before
it's logged or serialized, given a set of known-sensitive field names and a set of known-sensitive
literal values.

### How

**1. Route + method, not action type.** `authorize()` never looks at whether the `Action` was a
`click` or a `navigate` to decide "safe" versus "risky" — it resolves the actual pending HTTP
method and path, then checks *that* against `routes[]`:

```ts
private authorizeUrl(url: string, method: "GET" | "POST"): AuthorizationResult {
  if (!isBaseUrlAllowed(this.config, url)) {
    return { allowed: false, risk: "risky", reason: `Target URL ${url} is outside the allowed base URLs.` };
  }
  const pathname = new URL(url).pathname;
  const match = matchRoute(this.config, pathname, method);
  if (!match) {
    return { allowed: false, risk: "risky", route: pathname, method, reason: `${method} ${pathname} is not in the configured route allowlist.` };
  }
  return { allowed: true, risk: match.rule.risk, route: pathname, method };
}
```

For `type` / `select_option` / `extract` actions, `authorize()` returns `{ allowed: true, risk:
"safe" }` immediately — these never submit anything by themselves; the actual state-changing
`navigate`/`click` that eventually follows is what gets checked.

**2. Getting the real destination — `Surface.predictNavigation()`.** For a `click` or
`navigate`, guardrails needs to know the *actual* pending method and URL — a form's real
`method`/`action` attributes, or a link's real `href` — not a guess. `predictNavigation()` returns
one of three distinct things, and `authorize()` treats all three differently:

```ts
const predicted = await surface.predictNavigation(action);

if (predicted === undefined) {
  // The target element didn't resolve at all. perform() is about to fail on its own,
  // and that failure flows through normal known-outcome detection -- not the
  // guardrail layer. This is what "the Open Sub-Account link legitimately isn't
  // rendered on a permission-denied page" looks like.
  return { allowed: true, risk: "safe" };
}

if (predicted === null) {
  // The element EXISTS but its destination can't be determined (no enclosing
  // form/anchor -- a JS-driven onclick/fetch write). Fail CLOSED.
  return { allowed: false, risk: "risky", reason: "Could not determine this action's destination..." };
}

return this.authorizeUrl(predicted.url, predicted.method);
```

This three-way split is the fix for a real, previously-shipped bug: collapsing `undefined` into
the same "block" bucket as `null` meant that on the mock bank's permission-denied page — where the
"Open Sub-Account" link is correctly absent for a restricted member — the guardrail layer reported
a security block instead of letting the actual page state (an `Access denied` business outcome)
surface normally through `src/replay/checkpoint.ts`'s known-outcome detection. `undefined` means
"there's nothing here to authorize or block, and something else already handles this correctly";
`null` means "there's something here, and I genuinely can't vouch for it."

**3. Origin comparison, not string prefix — `isBaseUrlAllowed()`.**

```ts
export function isBaseUrlAllowed(config: AllowlistConfig, url: string): boolean {
  let target: URL;
  try { target = new URL(url); } catch { return false; }
  if (target.username || target.password) return false; // userinfo-in-URL, never allowed

  return config.allowedBaseUrls.some((base) => {
    let baseUrl: URL;
    try { baseUrl = new URL(base); } catch { return false; }
    if (target.origin !== baseUrl.origin) return false;
    const basePath = baseUrl.pathname === "/" ? "" : baseUrl.pathname.replace(/\/$/, "");
    if (!basePath) return true;
    return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  });
}
```

The bug this replaced: `String.startsWith("http://localhost:4000")` is true for both
`http://localhost:40000/login` (a different port, a `"4000"` prefix match by coincidence) and
`http://localhost:4000.evil.example.com/login` (a subdomain of `evil.example.com`, not
`localhost:4000` at all). It's also true for `http://localhost:4000@evil.com/login`, which the URL
spec parses as userinfo `localhost:4000` on host `evil.com` — an actual navigation to `evil.com`.
Parsing the URL and comparing `.origin` (scheme + host + port, exactly) closes both holes; the
explicit `username`/`password` check is belt-and-suspenders on top, since a credentialed URL
should never be something this system navigates to or authorizes, allowlisted origin or not. If
an allowed base URL also specifies a path prefix, the match additionally requires a full path
segment boundary — `/app` must not also match `/app-danger`.

**4. Two checks per navigating action, not one.** `authorize()` runs *before* the action executes
(a prediction); `authorizeLandedUrl(surface.currentUrl())` runs *after* it executes (the actual
result), because a redirect chain, or a `POST` that gets re-rendered in place as a validation
error rather than redirecting, can land the browser somewhere the pre-flight check never saw. This
second check is method-agnostic on purpose (`matchRouteAnyMethod`) — "we're now at this pathname"
doesn't imply "we got here via a GET," since the pre-flight check already verified the real
method before the action ran. See [`06-deterministic-replay.md`](06-deterministic-replay.md) for
exactly where this runs inside the replay loop.

**5. Risky vs. safe, and `--allow-risky`.** In this demo config, every `GET` is `safe` and the one
write (`POST /members/:id/sub-accounts`) is `risky`. The conservative default is: a risky action
always requires confirmation — interactively during discovery, and during replay either an
interactive prompt or the explicit `--allow-risky` flag, which stands in for "this artifact was
reviewed and approved for unattended production execution." Critically, `--allow-risky` is *not* a
bare trust-me switch: it's gated by the artifact's approval state in
`evidence/artifacts/registry.json` — a freshly recorded artifact is `draft`, where `--allow-risky`
is silently ignored and risky steps always block on interactive confirmation regardless of the
flag, and only an explicitly `npm run approve`d artifact honors it at all (and even then, a drift-
degraded confidence score can pull that back to attended confirmation). The full mechanics of that
gate — confidence scoring, the `draft`/`approved` states, the drift-based circuit breaker — live in
[`10-confidence-and-approval.md`](10-confidence-and-approval.md); the point that matters here is
that "risky" is the trigger, and confidence/approval is what's allowed to relax the response to
that trigger, never guardrails itself.

**6. Redaction — key-based and value-based, together.** `redact()`
(`src/guardrails/redaction.ts`) is applied to everything written to `/evidence` and to artifacts
before serialization:

```ts
const SENSITIVE_KEY_PATTERN = /password|secret|token|ssn|social_security|credit_?card|cvv|\bpin\b/i;
const MIN_SCRUBBABLE_VALUE_LENGTH = 6;

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const sensitiveKeys = options.sensitiveKeys ?? new Set<string>();
  const sensitiveValues = options.sensitiveValues ?? new Set<string>();

  // Checked BEFORE type-based branching: a flagged key masks its whole value no
  // matter its shape (string, number, nested object).
  if (options.keyHint && (sensitiveKeys.has(options.keyHint) || SENSITIVE_KEY_PATTERN.test(options.keyHint))) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return scrubString(scrubKnownValues(value, sensitiveValues));
  if (Array.isArray(value)) return value.map((item) => redact(item, { sensitiveKeys, sensitiveValues }));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(val, { sensitiveKeys, sensitiveValues, keyHint: key });
    }
    return out;
  }
  return value;
}
```

Two independent mechanisms, layered:
- **Name-based masking**: any field whose *key* matches `SENSITIVE_KEY_PATTERN` (or is in the
  artifact's own declared `sensitiveKeys`, from `inputParams[].sensitive`) gets fully masked,
  regardless of what shape its value is — a string, a number, a nested object. The key-hint check
  deliberately runs *before* any type branching; an earlier version only applied it inside the
  `typeof value === "string"` case, so a sensitive key holding a number, boolean, or nested object
  (e.g. `{ pin: 4821 }`) passed straight through unmasked.
- **Value-based masking**: `EvidenceLogger.addSensitiveValue()` registers literal secret values
  up front (e.g. the CLI's `--password` argument), and every string logged afterward gets scanned
  for that exact value, regardless of which field it turns up in. This is the fix for a real bug:
  the discovery goal string is a plain-English sentence that embeds the actual password
  ("...password 'demo_password'...") for the model to read and type. The very first log line of a
  run — the goal itself — would otherwise have written that password to disk in the clear, before
  the discovery loop had ever "seen" a field it could recognize as sensitive by name. Registering
  known secret values before any logging starts closes that gap regardless of which field a
  secret happens to flow through.
- **Minimum-length floor**: `MIN_SCRUBBABLE_VALUE_LENGTH = 6`. Below this length, a substring scan
  across an entire log line does more harm than good — a short or weak secret could coincidentally
  match part of an unrelated member ID or dollar amount elsewhere in the same log entry, over-
  redacting legitimate business data that happened to share a few digits. Key-based redaction is
  unaffected by this floor — a short secret stored under a flagged key (e.g. a 4-digit PIN) is
  still fully masked by the name-based check regardless of length.
- **Defense in depth**: `scrubString()` additionally masks any SSN-shaped (`\d{3}-\d{2}-\d{4}`) or
  card-number-shaped (13–19 digit run) string anywhere, independent of field name or registration.

### Where

- `src/guardrails/policy.ts` — `GuardrailsPolicy.authorize()`, `authorizeLandedUrl()`.
- `src/guardrails/allowlist.ts` — `matchRoute()`, `matchRouteAnyMethod()`, `isBaseUrlAllowed()`,
  `loadAllowlist()`.
- `src/guardrails/redaction.ts` — `redact()`, `scrubString()`, `scrubKnownValues()`.
- `config/allowlist.json` — the actual route rules for the demo app.
- `src/surface/types.ts` — `predictNavigation(action): Promise<PredictedNavigation | null |
  undefined>`, the three-way contract guardrails depends on.
- `src/evidence/logger.ts` — `EvidenceLogger.addSensitiveKeys()` / `addSensitiveValue()`, which
  feed `redact()`'s `sensitiveKeys`/`sensitiveValues`.
- `src/replay/replay-engine.ts` — `authorizeAndConfirm()`, the one call site that gates every
  action (original attempt, every recovery step, every retry) through `authorize()` — see
  [`06-deterministic-replay.md`](06-deterministic-replay.md).

### A worked technical example

Discovery's confirmation prompt for the one risky route in this demo config, exactly as it
appears on a real run (`README.md` step 2):

```
=== RISKY ACTION REQUIRES CONFIRMATION ===
POST /members/10001/sub-accounts is classified risky and requires confirmation.
Type 'yes' to proceed, anything else to decline:
```

This is `authorize()` resolving `predictNavigation()`'s prediction for the "Submit" button's
enclosing form (`method: "POST"`, `action: "/members/10001/sub-accounts"`), matching it against
`config/allowlist.json`'s `{ "pattern": "/members/:id/sub-accounts", "methods": ["POST"], "risk":
"risky" }` rule, and returning `{ allowed: true, risk: "risky" }` — which the caller (discovery's
loop, or replay's `authorizeAndConfirm`) turns into this confirmation prompt rather than executing
immediately.

### Edge cases & failure modes

- **A URL that doesn't even parse** (`new URL(url)` throws) is treated as not allowed, not as an
  exception bubbling up — both in `isBaseUrlAllowed()` and in the allowlist's own `base` entries.
- **An allowed base URL with a path prefix** (`http://host/app`) requires a full path-segment
  match against the target — `/app` does not also permit `/app-danger`.
- **A `click_coordinates` action** (the vision-grounded fallback, see
  [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md)) is always classified `risky` and never
  blocked outright: its destination can never be verified in advance by definition (there's no DOM
  element to inspect), so treating it as `safe` would let a vision-based guess bypass confirmation
  entirely, while treating it as blocked would make a deliberately-chosen fallback mechanism
  permanently inert.
- **A landed URL after a redirect or in-place re-render** is re-checked independently of the
  pre-flight prediction (`authorizeLandedUrl`), because the two can legitimately disagree.
- **A sensitive value shorter than 6 characters** is still fully masked if it's stored under a
  name-flagged key, but is not scrubbed as a floating substring elsewhere in a log line — this is
  a deliberate false-positive/false-negative trade-off, not an oversight.
- **A required field's value happens to itself be a well-known secret string reused elsewhere on
  the page** (e.g. the same password appearing in an error message) — value-based scrubbing masks
  every occurrence, not just the one in the field it was typed into.

## Related docs

- [`06-deterministic-replay.md`](06-deterministic-replay.md) — where `authorizeAndConfirm` and
  `authorizeLandedUrl` are actually called during a run
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — how `--allow-risky` is gated
  by an artifact's approval state and drift-adjusted confidence, in full
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — what happens when a risky step
  is declined, or a hard failure needs a human
- [`03-surface-abstraction.md`](03-surface-abstraction.md) — `predictNavigation()`'s full contract
- [`../REPORT.md`](../REPORT.md) — see "6. Safety" for the original design write-up this doc
  expands on
- [`../SECURITY.md`](../SECURITY.md) — the project's broader security posture
- [`../README.md`](../README.md) — step 2's real confirmation-prompt example used above
