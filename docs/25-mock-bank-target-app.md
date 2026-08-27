# The Mock Bank: This Project's Practice Target

## In one sentence

`apps/mock-bank/` is a small, deliberately old-fashioned fake banking web app — built from
scratch specifically so every hard scenario this system needs to prove it can handle (a
missing member, a permission wall, a session timeout, a slow page, a surprise pop-up
dialog, a rebranded sister bank, a screen with no clickable structure at all) could be
engineered on purpose, instead of hoping a real bank or a generic demo site happened to have
one.

---

## Part 1 — For everyone: why build a fake bank at all?

### The analogy

A flight simulator doesn't just let a trainee pilot fly in nice weather forever. It has a
specific scenario for an engine failing on takeoff. A specific scenario for landing in bad
weather with low visibility. A specific scenario for an instrument going haywire mid-flight.
None of those exist because engines fail constantly in real life — they exist because a pilot
*needs to have practiced them*, deliberately, before the day one actually happens for real.

`apps/mock-bank` is this project's flight simulator. It's not a real credit union's software
(the take-home brief explicitly says not to go try to get access to one — real banks don't
hand out test accounts to take-home candidates, for good reason). It's also not some public
demo website scraped off the internet, because a public demo site can't guarantee it will ever
show you "member not found," or "your session just expired," or "here's a confirmation dialog
nobody expected," on command, reliably, over and over, so the automation's handling of each one
can actually be checked. So instead, a small banking app was built by hand, specifically so
every one of those situations could be planted in it deliberately — a known button labeled
`10001` that always works, a known button labeled `99999` that's always denied, and so on.

### A concrete walkthrough

Start it for real:

```bash
npm run mock-bank
# -> mock-bank listening on http://localhost:4000 (tenant: mock-bank)
```

Sign on as `demo_operator` / `demo_password`, look up member `40404` (a member ID nobody
seeded), and replay reports exactly this, not a crash:

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"40404","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true
```

```json
{
  "status": "business_outcome",
  "outcome": "member_not_found",
  "description": "No member exists with the given memberId. A legitimate result, not a crash.",
  "stepId": "step-6"
}
```

That result is exactly as reliable as it is because `apps/mock-bank/src/data.ts` seeds member
`40404` as "doesn't exist" on purpose, every time, forever — not because a real bank happened to
be missing that member the day someone tested it.

### Every seeded scenario, and what it proves

| Member ID / route | What's seeded | What it proves the system handles |
|---|---|---|
| `10001` (Alice Johnson), `10002` (Bob Martinez) | Ordinary members with real balances | The happy path, start to finish — sign on, look up, open a sub-account, reach confirmation |
| `40404`, or any ID not in the seed list | Not seeded at all | `business_outcome: member_not_found` — a normal business answer, not a crash |
| `99999` (Restricted Member) | `permissionRestricted: true` | `business_outcome: permission_denied` — the operator can look the member up but is denied access to their data |
| `55555` (Slow Member) | `simulateSlow: true` — a real 3-second server delay before the page renders | The system waits it out and proceeds normally; a slow page is not the same thing as a broken one |
| `90909` (Tempo Member) | Session is force-expired exactly **once** the first time this ID is used after a reset, then it's fine | A `recoverable` outcome: the automation notices the session died, signs back in, and finishes the task, no human needed |
| any member + a deposit under `$25` | The server's own minimum-deposit validation | `business_outcome: validation_error` — a legitimate rejection, not a bug |
| `77777` (Dormant-Flag Member) | `requiresInterstitialConfirmation: true` — opening a sub-account renders a surprise "Additional Confirmation Required" page instead of going straight through | The genuinely-unanticipated case: nothing in the recorded artifact explains this page, so replay hard-fails and calls a human over to click "Confirm & Continue" on the live session |
| `/legacy-widget-demo` | A button drawn entirely on an HTML `<canvas>`, with no real DOM element, role, or name behind it at all | The last-resort vision-grounded fallback: the model has to recognize there's nothing to click by name, and click by pixel coordinates instead |
| `northgate-cu` tenant (`TENANT=northgate-cu PORT=4100`) | The exact same app, same routes, same business rules, different visible copy and an extra banner row | Cross-tenant reuse: one recorded artifact, adapted with a small override file, works against a second, differently-branded "bank" without being re-recorded |
| `/members/new` + `POST /members` | Enroll a brand new member (name + optional starting balances, defaulting to $0) | A second, independent capability (`create-member`) with its own `validation_error` outcome, and the real bug it surfaced: deposit fields that were marked "required" when the app itself treats a blank one as $0 |
| `/members/:id` (balances already shown) | No new route at all | `check-balance`: proof that a capability doesn't always need new app surface, just a discovery run that reaches and extracts what's already there |
| `/members/:id/transfer` | Move funds between a member's own checking/savings | `transfer-funds`, with two distinct business outcomes: `insufficient_funds` and `invalid_transfer` (bad amount, or the same account twice) |
| `/members/:id/sub-accounts/:subId/close` | Close an existing sub-account; the link stays visible even once closed | `close-sub-account`'s `already_closed` outcome, and the real bug fixed to make it reachable at all — see this doc's Part 2 "Edge cases" and REPORT.md for the full story |

### "What happens if...?"

| Situation | What happens |
|---|---|
| You look up a member ID that was never seeded | Server redirects back to search with a "no member found" message; replay reports `business_outcome: member_not_found`, not a failure |
| You try to open an account with a deposit of `$10` | Server re-renders the same form with a minimum-deposit error message; replay reports `business_outcome: validation_error` |
| You hit member `90909` a second time in the same run | The one-shot timeout is already spent (it resets only via `POST /__test__/reset`), so this time it behaves like an ordinary member |
| You ask for an `accountType` the dropdown doesn't actually offer (e.g. `"MoneyMarket"`) | There's no seeded scenario for this at all — it's a genuinely unanticipated deviation, and replay correctly reports a `failure`, not a business outcome, because nothing in `knownOutcomes` explains it |
| You point the same recorded artifact at the `northgate-cu` tenant with no override | Locators that depend on exact button text ("Sign On" vs "Log In") can fail — a deliberate negative control proving the override is actually load-bearing, not decorative |
| You try to click the canvas widget by role or name | There's nothing to find — no DOM button exists at all, which is exactly the point |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief explicitly rules out trying to get access to a real bank's back-office system, and a
generic public demo site can't be relied on to reliably reproduce specific, repeatable
failure modes on command. A purpose-built fixture solves both problems at once: it can be
made as legacy-looking as needed (server-rendered HTML, table layouts, no CSS framework, no
`data-testid` hooks anywhere), and every hard scenario the system needs to prove it handles —
a business error, a permission wall, a transient timeout, a slow load, a genuinely
unanticipated dialog, a multi-tenant rebrand, a surface with zero DOM semantics — can be
engineered into it deliberately, with a known trigger, instead of hoped for.

### What

`apps/mock-bank/` is a small Express + EJS server-rendered app:

- `src/server.ts` — the whole app: session-based auth (`express-session`), and the
  member-search → member-detail → open-sub-account → confirmation flow.
- `src/data.ts` — the in-memory data model: `Member` and `SubAccount` interfaces, a seed list
  of six members, and `resetData()` / `POST /__test__/reset` to return to a known state
  between runs (not a real banking feature — a documented local-demo affordance).
- `src/tenants.ts` — `TenantLabels`, the per-tenant copy (button text, error text, labels) that
  makes the same app serve two differently-branded "banks."
- `views/*.ejs` — deliberately old HTML: `<table>` layouts, `<font>` tags, `bgcolor`
  attributes, no CSS framework, and no `data-testid`/automation hooks anywhere, forcing the
  system's locator strategies to fall back to role/name, visible text, and structural CSS —
  never a convenient purpose-built hook.

Real example, straight out of `views/newSubAccount.ejs`:

```html
<body bgcolor="#d6d3ce">
<table width="100%" cellpadding="4" cellspacing="0" border="0">
  <tr bgcolor="#003366">
    <td><font color="#ffffff" face="Arial" size="4"><b>Member Services Terminal</b></font></td>
    ...
```

No `id`, no `class`, no `data-testid` — a real button on this page has to be found by its
visible label text or its role, exactly the constraint a genuinely old back-office app would
impose.

### How

Routes in `src/server.ts`, in the order a real session walks them:

| Route | Purpose |
|---|---|
| `GET/POST /login` | Session-based sign-on; sets `req.session.username` |
| `GET /search` | Member lookup by ID; redirects to the member page or shows a not-found message |
| `GET /members/new`, `POST /members` | The `create-member` capability: enroll a brand new member (name + optional starting checking/savings, defaulting to $0 if left blank) |
| `GET /members/new/confirm/:id` | The new-member confirmation page |
| `GET /members/:id` | Member detail; branches on `simulateSlow` (awaits a 3s `delay()`) and `permissionRestricted` (renders an access-denied view); also where `check-balance` reads the already-shown checking/savings balances |
| `GET /members/:id/transfer`, `POST /members/:id/transfer`, `GET /members/:id/transfer/confirm` | The `transfer-funds` capability: move funds between a member's own checking and savings, with `insufficient_funds`/`invalid_transfer` business outcomes |
| `GET /members/:id/sub-accounts/new` | The "open a new sub-account" form |
| `POST /members/:id/sub-accounts` | Validates the deposit (`< 25` → `validation_error`), then either creates the account directly or, for `requiresInterstitialConfirmation` members, renders the surprise interstitial instead |
| `POST /members/:id/sub-accounts/confirm-interstitial` | The human's one manual click dismissing that interstitial, on the *same* live session |
| `GET /members/:id/sub-accounts/:subId/confirm` | The confirmation page, showing a real generated account number (`SA-00001`, `SA-00002`, …) |
| `GET/POST /members/:id/sub-accounts/:subId/close`, `GET /members/:id/sub-accounts/:subId/closed` | The `close-sub-account` capability; all three share one lookup+ownership-check helper, `findSubAccountForMember()` in `data.ts` |
| `POST /__test__/reset` | Test-only: resets all in-memory state via `resetData()` |
| `GET /legacy-widget-demo`, `/legacy-widget-demo/confirmed` | The canvas-only fixture and its landing page after a successful click |

Those three close-sub-account routes originally each repeated the same six-line block
inline — look up the member, look up the sub-account, verify the sub-account actually belongs
to that member, 404 otherwise — real, verified duplication (checked by direct diff across all
three routes, not just similar-looking code), now centralized as `findSubAccountForMember()`
in `data.ts`:

```ts
export function findSubAccountForMember(memberId: string, subId: string): { member: Member; subAccount: SubAccount } | undefined {
  const member = findMember(memberId);
  const subAccount = findSubAccount(subId);
  if (!member || !subAccount || subAccount.memberId !== member.id) return undefined;
  return { member, subAccount };
}
```

Verified live after the change, not just by unit test: a real open→close round trip (a fresh
sub-account opened, then closed for real), a real re-close of the same, already-closed
sub-account (correctly reporting the `already_closed` business outcome, not a crash), and a
direct request for a nonexistent sub-account id (correctly a real 404).

The session-timeout scenario is implemented as a one-shot arm/consume pair in `data.ts`:

```ts
export let sessionTimeoutArmed = true;
export function consumeSessionTimeoutArm(): boolean {
  if (!sessionTimeoutArmed) return false;
  sessionTimeoutArmed = false;
  return true;
}
```

`server.ts` checks `id === TIMEOUT_TRIGGER_ID ("90909") && consumeSessionTimeoutArm()` in both
`/search` and `/members/:id`; the first hit destroys the session and redirects to
`/login?reason=timeout`, and every hit after that (until `resetData()` runs again) behaves
like an ordinary member — a *transient* glitch, not a permanently broken one, which is exactly
what makes it a `recoverable` known outcome rather than a business outcome or a hard failure.

The multi-tenant variant is a single environment-variable switch, not a fork:

```bash
TENANT=northgate-cu PORT=4100 npm run mock-bank
```

`getTenantLabels(process.env.TENANT ?? "mock-bank")` looks up a `TenantLabels` record from
`src/tenants.ts` and every view reads it off `res.locals.labels` — same routes, same form
field `name`/`id` attributes, same business rules, only the visible copy (and one extra promo
banner row that shifts every position-based DOM path) differs. This is what
[`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md)'s override mechanism is tested against.

The canvas-only fixture (`views/legacyWidgetDemo.ejs`) draws its "Check Balance" button
entirely with `CanvasRenderingContext2D` calls — there is no DOM button, link, or any element
with a role or accessible name for `src/surface/dom-scan.ts`'s walker to find. `server.ts` has
to disable Helmet's default CSP (`helmet({ contentSecurityPolicy: false })`) specifically so
this page's inline `<script>` isn't blocked — a deliberate, documented exception, made safe
because mock-bank is the fake target being automated against, not the system whose hardening
matters (see `../SECURITY.md`).

### Where

- `apps/mock-bank/src/server.ts` — every route.
- `apps/mock-bank/src/data.ts` — `Member`, `SubAccount`, the seed list, `resetData()`,
  `consumeSessionTimeoutArm()`, `findSubAccountForMember()`.
- `apps/mock-bank/src/tenants.ts` — `TenantLabels`, `getTenantLabels()`, the `mock-bank` and
  `northgate-cu` tenant records.
- `apps/mock-bank/views/*.ejs` — `login.ejs`, `search.ejs`, `member.ejs`, `newSubAccount.ejs`,
  `subAccountInterstitial.ejs`, `confirmation.ejs`, `legacyWidgetDemo.ejs`,
  `legacyWidgetConfirmed.ejs`.
- `config/tenant-overrides/northgate-cu.json` — the override file that adapts the base
  artifact to the rebranded tenant, described in
  [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md).
- Runs against it, checked into `/evidence`: a clean discovery success, replay runs covering
  every row of the scenario table above, the cross-tenant reuse pair, and the vision-fallback
  run against `/legacy-widget-demo`.

### Worked technical example

Real recorded output for the deliberately-unanticipated `accountType` case (the fourth,
genuine `failure` leg of the replay contract, as opposed to a modeled `business_outcome`):

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"MoneyMarket","initialDeposit":"100"}' \
  --allow-risky true
```

```json
{
  "status": "failure",
  "stepId": "step-8",
  "expected": "select_option to succeed",
  "observed": "locator.selectOption: Timeout 5000ms exceeded. ... did not find some options",
  "evidenceRef": "evidence/runs/replay-2026-08-14T20-49-43-683Z/screenshots/001-failure-step-8.png"
}
```

Nothing in `apps/mock-bank` had to special-case this — the dropdown in `newSubAccount.ejs`
genuinely only offers `Savings`/`Checking`/`CD`, so asking for `MoneyMarket` produces a real
Playwright timeout, exactly the kind of unmodeled deviation the `failure` branch of the
contract exists for.

### Edge cases & failure modes

- **`resetData()` used to keep only a shallow copy of the seed list.** An earlier version
  assigned direct references into `seedMembers` rather than deep clones, so any in-place
  mutation of a served `Member` object before the *first* reset would have permanently
  corrupted the seed data for the process's whole lifetime. Fixed with `structuredClone()`;
  now every reset starts from a truly fresh copy.
- **An unrecognized `TENANT` value.** `getTenantLabels()` falls back to the `mock-bank` tenant
  record (`TENANTS[tenantId] ?? TENANTS["mock-bank"]!`) rather than throwing, so a typo'd
  `TENANT` env var degrades to the default bank instead of crashing the process.
- **Hitting member `90909` twice in a row within the same process lifetime.** Only the first
  hit after a reset triggers the forced session expiry; the arm is consumed on use, so a second
  attempt behaves like an ordinary member until `POST /__test__/reset` re-arms it.
- **The interstitial scenario (`77777`) has no parameter to skip it.** This is deliberate: a
  real unanticipated dialog isn't something a caller's own input parameters could have
  predicted either, so there's no "skip the surprise" flag — the point is to force a genuine
  hard-fail-then-escalate path.
- **CSP is disabled for this whole app**, not just the one canvas-demo route. Documented and
  intentional (see `../SECURITY.md`) — this app is the fake target under test, not the system
  being hardened, so the usual "why is CSP off" red flag doesn't apply the same way here.
- **The `/__test__/reset` route has no auth check at all.** Fine for a local fixture that's
  never meant to be deployed for real; called out explicitly in README.md as a documented
  local-demo affordance, not something a real banking app would ever expose.
- **The member page originally hid the "Close" link once a sub-account was already closed**
  — reasonable-looking, and wrong: it meant the recorded `close-sub-account` artifact could
  never be replayed a *second* time against the same account, since the link its own step
  targets simply wasn't rendered. Hard-failed instead of reaching the intended
  `already_closed` business outcome. Fixed by keeping the link reachable regardless of
  status; the server, not the client-side link, is what should report "already closed." A
  real bank's legacy UI plausibly behaves the same way — the affordance stays, the backend
  is the source of truth.

## Related docs

- [`00-problem-and-solution.md`](00-problem-and-solution.md) — why this system exists, and why
  legacy UIs with no API are the whole point
- [`03-surface-abstraction.md`](03-surface-abstraction.md) — how the system reads a page like
  this one's, with no test IDs to rely on
- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the three-way
  success/business_outcome/failure contract this app's scenarios are built to exercise
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — what happens on the `77777`
  interstitial and the canvas-only fixture when automation genuinely can't proceed alone
- [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) — the override mechanism tested
  against this app's `northgate-cu` tenant
- [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md) — the
  vision-grounded fallback exercised against `/legacy-widget-demo`
- [`21-testing-strategy.md`](21-testing-strategy.md) — why this app, not a mock, is the right
  way to verify real browser/model behavior
- [`../README.md`](../README.md) — the member-ID scenario table and exact commands to run each
  one live
- [`../REPORT.md`](../REPORT.md) — "why this app" and the cross-tenant negative-control
  evidence
- [`../SECURITY.md`](../SECURITY.md) — why this app's CSP exception isn't a double standard
