# Cross-Tenant Reuse

## In one sentence

The same recorded artifact can serve a second institution running the identical underlying
vendor software — just configured and branded differently — by applying a small, deliberately
narrow patch that changes only copy (button labels, error text, the base URL), never the
underlying flow, and there is real evidence proving that patch is actually load-bearing, not
just a nice-to-have.

---

## Part 1 — For everyone: one manual, plus a page of local differences

### The real-world analogy

Imagine a franchise business — a fast-food chain, say — with hundreds of locations. Headquarters
doesn't write a completely separate operations manual for every single location. Every location
runs the same procedures: how to take an order, how to make the food, how to close the register
at night. What differs from location to location is small and cosmetic: local signage, a
regional menu item's name, the specific phone number to call for a supply order. Each location
gets the same core manual, plus one page: "here's what's different at your location."

That one extra page is deliberately narrow. It says "call this button X here, that error message
reads differently here" — it never says "do the steps in a different order" or "skip a step
here." If a location's actual *procedure* is genuinely different, that's not a one-page patch
anymore — that's a different manual, reviewed and written from scratch.

This project has exactly that situation for real: it runs a small fake banking application
(`apps/mock-bank`) that can be configured to look like two different credit unions —
`mock-bank` (plain "CU Core" branding) and `northgate-cu` (rebranded as "Northgate Credit
Union Core") — while being the *literal same underlying code*, same routes, same form
fields, same business rules. Only the visible words differ: "Sign On" becomes "Log In,"
"Member ID" becomes "Member Number," "Submit" becomes "Confirm & Open."

### A concrete walkthrough, with real data from this repo

The artifact `open-sub-account` was recorded once, against the plain `mock-bank` tenant on
port 4000. To reuse it against the rebranded `northgate-cu` tenant on port 4100, without
re-recording anything:

```bash
npm run mock-bank:northgate
# -> mock-bank listening on http://localhost:4100 (tenant: northgate-cu)
```

```bash
curl -s -X POST http://localhost:4100/__test__/reset

npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/northgate-cu.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```

This completes end to end against a page that says "Log In" instead of "Sign On," "Find
Member" instead of "Look Up Member," and "Confirm & Open" instead of "Submit" — real evidence
checked in at `evidence/runs/replay-2026-08-25T17-52-53-914Z`, `status: success`. The override
that made this work, `config/tenant-overrides/northgate-cu.json`, is a small JSON file:

```json
{
  "tenantId": "northgate-cu",
  "vendorProductId": "mock-bank",
  "baseUrlPattern": "http://localhost:4100",
  "locatorOverrides": [
    { "stepId": "step-4", "strategy": "role", "name": "Log In" },
    { "stepId": "step-4", "strategy": "text", "name": "Log In" },
    { "stepId": "step-6", "strategy": "role", "name": "Find Member" },
    { "stepId": "step-6", "strategy": "text", "name": "Find Member" },
    { "stepId": "step-7", "strategy": "role", "name": "Open New Account" },
    { "stepId": "step-7", "strategy": "text", "name": "Open New Account" },
    { "stepId": "step-10", "strategy": "role", "name": "Confirm & Open" },
    { "stepId": "step-10", "strategy": "text", "name": "Confirm & Open" }
  ],
  "checkpointOverrides": [
    { "target": "success", "expr": "Account opened successfully" },
    { "target": "member_not_found", "expr": "We could not locate a member with number" },
    { "target": "permission_denied", "expr": "Not authorized to view this member" },
    { "target": "validation_error", "expr": "Minimum opening deposit is" },
    { "target": "session_timeout", "expr": "session timed out" }
  ]
}
```

That's the entire "page of local differences" — it changes which button label the automation
looks for and what success/error message text it recognizes. It never touches how many steps
there are, what order they run in, or what data goes in or comes out.

### The proof that this override actually matters

It would be easy to *assume* the override is doing real work without checking. This repo
actually checked, with a real negative control: the exact same base artifact, pointed at the
exact same rebranded tenant, but with a fixture that changes **only** the URL and applies **no**
locator or checkpoint patches at all
(`config/tenant-overrides/_negative-control-url-only.json`):

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/_negative-control-url-only.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```

This fails at `step-4` ("No locator candidate resolved to an element") — real evidence at
`evidence/runs/replay-2026-08-25T17-58-23-091Z`, `status: failure`. Pointing an artifact at the
right URL is not the same as adapting it to that tenant's page — the override layer is what
actually closes that gap.

### An honest wrinkle found along the way

Not every field needed patching. The username, password, member ID, account type, and deposit
amount fields all kept working on the rebranded tenant **even without any override at all** —
because those particular fields happen to carry HTML `id` attributes, and this system's
structural fallback locator collapses to `#id` whenever one is present. That's real, useful
resilience, but it's narrow and a little bit lucky: it works because of an incidental markup
detail, not because the system understands "this is the same field, just relabeled." That's
exactly why `northgate-cu.json` above only patches the four controls that *don't* have that
safety net — the Sign On/Log In button, the Look Up/Find Member button, the Open New
Sub-Account/Open New Account link, and the Submit/Confirm & Open button.

### "What happens if...?"

| Situation | What happens |
|---|---|
| The override file patches the right steps and checkpoints | Replay completes end to end against the rebranded tenant, no re-recording needed. |
| The override only changes the base URL, with no locator/checkpoint patches | Replay fails early (at the first mismatched control) — real proof the override isn't decorative. |
| An override references a step ID that doesn't actually exist in the artifact | The system throws a loud error immediately, rather than silently doing nothing and leaving the old tenant's locator in place. |
| An override's `vendorProductId` doesn't match the artifact's actual target app | The system refuses to apply it at all — an override written for one vendor product must never silently get applied to a different one. |
| A field happens to have a stable `id` attribute in the underlying markup | It may keep working across a rebrand even without being explicitly patched — free, but narrow, resilience. |
| The tenant's UI isn't just reworded, but genuinely does the task differently (extra step, different order) | A copy-only override can't express that — that tenant needs its own recording and its own review, not a bigger override file. |

---

## Part 2 — For engineers: why, what, how, where

### Why

interface.ai's own real environment is "hundreds of institutions, many running the identical
underlying vendor product, configured/branded/versioned differently." Re-recording the same
capability from scratch for every one of those institutions doesn't scale, and it also throws
away something valuable: the fact that the *flow itself* — what steps happen, in what order,
with what inputs and outputs — is usually unchanged between two tenants of the same vendor
product. What varies is copy: button labels, error message text, the base URL. Cross-tenant
reuse is built around that specific observation.

### What

`src/artifact/tenant-override.ts` defines the override shape, validated with Zod like
everything else this system produces or consumes:

```ts
export const TenantOverrideSchema = z.object({
  tenantId: z.string(),
  vendorProductId: z.string(), // must match the base artifact's target.appId
  baseUrlPattern: z.string().optional(),
  locatorOverrides: z.array(LocatorOverrideSchema).default([]),
  checkpointOverrides: z.array(CheckpointOverrideSchema).default([]),
});

export const LocatorOverrideSchema = z.object({
  stepId: z.string(),
  strategy: z.enum(["role", "text"]), // css_structural/test_id are NOT overridable here
  name: z.string(),
});

export const CheckpointOverrideSchema = z.object({
  target: z.string(), // "success", or a knownOutcomes[].name
  expr: z.string(),
});
```

The override is deliberately narrow about what it's allowed to touch:

- Only a step's `role` or `text` locator candidate's `name` — not `css_structural` or
  `test_id`. A structural fallback that happens to still resolve on a variant tenant is a
  property of *that tenant's markup*, not something a copy-only override should assert or rely
  on.
- Only a checkpoint or known-outcome detector's `expr` — the text pattern that decides what page
  the automation thinks it landed on.
- Optionally, the artifact's `baseUrlPattern`.

It cannot add or remove steps, change an action's type, or touch the artifact's input/output
contract. That line is intentional: "this tenant's UI uses different words for the same flow" is
a copy-only problem; "this tenant's flow is actually different" is a different, bigger problem
that needs its own recording and its own review — the same way a materially different
re-recording gets its own confidence-registry entry rather than inheriting trust it hasn't
earned (see [`10-confidence-and-approval.md`](10-confidence-and-approval.md)).

### How

`applyTenantOverride(artifact, override)`:

1. Throws immediately if `override.vendorProductId !== artifact.target.appId` — refuses to
   apply an override authored for one vendor product to a different one.
2. `structuredClone`s the base artifact — the original object passed in is never mutated.
3. Patches `baseUrlPattern` if provided.
4. For each locator override, finds the matching step by `stepId` and the matching locator
   candidate by `strategy`, and throws if either doesn't exist — a stale override silently
   leaving the *old* tenant's locator in place against the *new* tenant's page would be worse
   than a loud config error.
5. For each checkpoint override, patches either `successCheckpoint.expr` (for `target ===
   "success"`) or the matching `knownOutcomes[].detector.expr`, throwing if the named outcome
   doesn't exist.
6. Re-validates the patched result against `CapabilityArtifactSchema.parse()` before returning
   it — the same "validate what we produce, not just what we load" discipline the recorder
   applies to its own output.

`replay --tenant-override <path>` and `approve --tenant-override <path>` both apply this before
anything else touches the artifact, so the registry/confidence/replay pipeline all operate on
the tenant-effective content, not the base content. The capability API's `POST
/capabilities/:id/invoke` takes an optional `tenantId` in the request body
(`src/api/tenant-resolution.ts`), loads `config/tenant-overrides/<tenantId>.json`, and applies
the same function before replaying.

### Where

- `src/artifact/tenant-override.ts` — the override schema and `applyTenantOverride()`
- `config/tenant-overrides/northgate-cu.json` — the real, committed override for the second tenant
- `config/tenant-overrides/_negative-control-url-only.json` — the deliberately incomplete fixture used to prove the override is load-bearing
- `apps/mock-bank/src/tenants.ts` — the `TenantLabels` the mock app itself uses to render two differently-branded but functionally identical tenants
- `src/api/tenant-resolution.ts` — HTTP-facing tenant resolution for the capability API
- `src/artifact/registry.ts` — content-fingerprint keying, which is why an overridden artifact gets its own independent trust record (see below)

### A worked technical example

Success, with the real override applied:

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/northgate-cu.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```
Result: `status: success`, real confirmation number, evidence at
`evidence/runs/replay-2026-08-25T17-52-53-914Z`.

Failure, with the negative-control fixture (URL-only, no patches):
```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --tenant-override config/tenant-overrides/_negative-control-url-only.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10001","accountType":"Savings","initialDeposit":"100"}'
```
Result: `status: failure` at `step-4` ("No locator candidate resolved to an element"), evidence
at `evidence/runs/replay-2026-08-25T17-58-23-091Z`.

### Edge cases & failure modes

- **Missing step/strategy/known-outcome in an override throws, never silently no-ops.** A stale
  override that references something that no longer exists on the base artifact is a config bug
  and is treated as one — replay fails loudly at override-application time, not three steps into
  an unattended run.
- **Vendor-product mismatch throws.** An override for one vendor product can never accidentally
  get applied to a different one.
- **Fingerprint collision for URL-only overrides.** `fingerprintArtifact()` (see
  [`10-confidence-and-approval.md`](10-confidence-and-approval.md)) deliberately excludes
  `baseUrlPattern` from the hash, so a re-recording pointed at a different environment still
  shares history with the original. That has a real, honest downside: the negative-control
  fixture above, which changes *only* `baseUrlPattern`, produces the exact same content
  fingerprint as the base artifact. This wasn't theoretical — its failure briefly showed up in
  the *base* artifact's own confidence history until it was removed by hand. A later fix
  (`expectedTenantId` in `src/replay/drift-loader.ts`) resolved this for the drift/confidence-
  adjustment signal specifically, by using each run's own *declared* `tenantOverride` (logged on
  its `start` event) as the source of truth for which surface it actually ran against, instead
  of the coincidental fingerprint match. What's still a manual fix, not a code fix: the raw
  `evidence/artifacts/registry.json` history entries themselves are still keyed by content
  fingerprint alone, so a collision like this can still misfile a replay *outcome* into the
  wrong artifact's trust history if it happens again.
- **A real path-traversal bug, found and fixed.** `tenantId` on the capability API's `invoke`
  route originally reached `path.join(overridesDir, tenantId + ".json")` straight from an
  untrusted HTTP request body (or a model's own output, via the conversational front end), with
  nothing stopping a value like `"../../../../etc/passwd"` from resolving outside
  `config/tenant-overrides/` entirely. Fixed by validating `tenantId` against
  `^[a-zA-Z0-9_-]+$` before any path is built or any filesystem call is made — see
  `src/api/tenant-resolution.test.ts` and `SECURITY.md` "Path traversal."
- **The `id`-attribute resilience is real but narrow.** Some fields resolve correctly across a
  rebrand purely because they happen to carry stable `id` attributes and the structural fallback
  collapses to `#id`. That's not something to rely on by design — it's an incidental property of
  this particular mock app's markup, not a guarantee any other tenant's underlying HTML will
  share.
- **No canonicalization pass, and no override-authoring tool.** A generic route-pattern
  normalizer (`/members/12345` → `/members/:id`) wasn't needed here because the existing
  path-template checkpoints already cover it; `northgate-cu.json` was hand-authored, the same
  posture as `knownOutcomes` authorship in general.

## Related docs

- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — why an overridden artifact gets its own independent draft/approved state
- [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — per-tenant drift signals, and the fingerprint-collision bug this surfaced twice
- [`SECURITY.md`](../SECURITY.md) — the path-traversal fix and the capability API's authentication model
- [`REPORT.md`](../REPORT.md) — "Heterogeneity & multi-tenant" and "Stretch goals: Cross-tenant reuse" for the full design narrative
- [`README.md`](../README.md) — demo path step 6 for these exact commands in context
