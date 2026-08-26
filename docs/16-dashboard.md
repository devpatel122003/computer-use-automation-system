# The Capability Dashboard

## In one sentence

A small, password-protected web page that reads the same files four separate CLI commands
already read — the artifact contract, the approval/confidence registry, the UI-drift signal,
and the run logs — and shows all of it on one screen, recomputed fresh from disk on every
request, without ever writing anything itself.

---

## Part 1 — For everyone: one screen instead of four gauges

### The analogy

Think of the dashboard in a car. A car already has a fuel sensor, a speed sensor, and an
engine-temperature sensor — each one perfectly capable of reporting its own number on its own
little gauge, in its own corner of the car. The dashboard doesn't invent any new sensor and
doesn't change how the engine runs. It just puts fuel, speed, and temperature in front of the
driver's eyes at the same time, so nobody has to walk around the car checking three different
places before pulling onto the highway.

This project's dashboard does exactly that, for a "capability" (a recorded, reusable task like
"open a sub-account") instead of a car. Before the dashboard existed, answering "is this
capability healthy?" meant running four different commands and reading four different outputs
in your head. The dashboard is the one screen.

### A concrete walkthrough, with real data from this repo

Starting the dashboard:

```bash
npm run dashboard
# -> Capability dashboard listening on http://localhost:4600
```

Opening `http://localhost:4600` in a browser pops up a native username/password prompt (any
username, and the password from `DASHBOARD_PASSWORD` in `.env`) — that's real HTTP Basic
authentication, not a placeholder login form. Once past it, here is what the page actually
showed when this doc was written, read straight from this repo's own `evidence/` folder:

- **Open Sub-Account v1.0.0** — badges: `✓ approved`, `⚠ medium`. Fingerprint
  `006fd53ee041c1ca` · **18/21 clean runs** · app: `mock-bank`.
- **Discovery vs. replay**, computed from real log timestamps, not made-up numbers:
  - Discovery (LLM-driven): **13.9s** avg over 12 run(s) · **6.9 model calls/run**
  - Replay (deterministic): **2.9s** avg over 22 run(s) · **0 model calls**
  - Replay vs. discovery: **4.8x faster** — 6.9 model call(s) avoided, every invocation
- **UI-drift signal**: ten steps, all `✓ stable` across 22 matching replay runs, except
  `step-11` ("Extract value from text `SA-00001`"), flagged `⚠ drift` at `1/12` — because a
  confirmation-number string that's different every time it's generated will, by definition,
  never text-match what was recorded (this is a known, harmless false-positive category, not a
  real regression).
- **Tenant variants**: `northgate-cu`, fingerprint `3916eebec9394f52`, `✓ approved`,
  `⚠ low` confidence, `1/2` clean runs, `⚠ 3 step(s) drifting`.
- **Cross-tenant drift comparison**: a step-by-step table with a `base` column and a
  `northgate-cu` column side by side — `step-2`, `step-3`, and `step-5` show `⚠ drift` for
  northgate-cu (its differently-branded UI needed a fallback locator there) while `step-4`,
  `step-6` through `step-10` are `✓ stable` on both.

None of that is a second copy of the data. Every one of those numbers is the *same* data the
`replay`, `approve`, and `drift-report` CLIs already produce — just assembled into one page.

### "What happens if...?"

| Situation | What happens |
|---|---|
| No capability has ever been recorded yet | The page shows "No capability artifacts found under `evidence/artifacts`." — not an error. |
| You type the wrong dashboard password | The browser's own login prompt reappears (a 401 with a `WWW-Authenticate` header) — no custom login page, no hint about what went wrong. |
| A `replay` or `approve` command is running in another terminal right now | Nothing bad happens. The dashboard makes no writes and holds no state between requests, so refreshing the page just shows whatever is true on disk *at that instant* — including a run that finished one second ago. |
| A capability has no tenant overrides at all | The "Tenant variants" and "Cross-tenant drift comparison" sections simply don't render — there's nothing to compare yet. |
| A discovery run happened, but no replay has ever been run against the resulting artifact | The "Discovery vs. replay" section still shows the discovery tile, but no replay tile and no speedup number — reporting a real comparison you don't have data for would be worse than not showing one. |
| Someone tries to *do* something from the dashboard — trigger a replay, approve an artifact | There's no button for it. The page has no forms and no client-side JavaScript; it is read-only by construction, not just by convention. |
| `DASHBOARD_PASSWORD` isn't set in `.env` | The dashboard process refuses to start at all, with an explicit error — it fails loud and closed rather than silently serving the page to anyone. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Three things this system already builds — the artifact schema, the confidence/approval
registry, and the UI-drift signal — were each real but only visible as JSON or stdout from a
separate CLI invocation (`replay`, `approve`, `drift-report`, plus reading
`evidence/artifacts/registry.json` by hand for confidence history). Turning that into a page a
non-engineer can read at a glance is presentation on existing depth, not new business logic.
It is explicitly **not** the brief's Section 8 "agent-facing capability interface" stretch
goal — that's the separate Capability API on port 4700 (bearer/API-key auth, meant to be
called by code); the dashboard is a human-facing page (HTTP Basic auth, meant to be opened in
a browser) with nothing callable by an agent. See `REPORT.md` §1 for the line drawing that
distinction explicitly.

### What

Three files, each with one job:

- **`src/dashboard/server.ts`** — the Express app. Binds `DASHBOARD_PORT` (default `4600`),
  applies `helmet()` and a structured request log, leaves `/health` open (for container/
  orchestrator checks), and gates every other route behind `requireBasicAuth("DASHBOARD_PASSWORD")`
  from `src/http/api-key-auth.ts`. The one real route, `GET /`, calls `buildCapabilityViews()`
  and hands the result to `renderDashboard()`.
- **`src/dashboard/metrics.ts`** — pure functions turning a run's log events into numbers:
  `computeRunMetrics(runId, events)` returns `{ runId, durationMs, llmCalls }`, where
  `durationMs` is `lastEvent.ts - firstEvent.ts` (every run log is append-only and already
  chronological, so no sorting is needed) and `llmCalls` is a count of log entries with
  `phase === "decide"` — always `0` for a replay run, since replay never calls a model.
  `aggregateRunMetrics()` averages across runs; `formatSpeedup()` turns two averages into an
  honest `"4.8x"`-style string, or `null` if there isn't enough data on either side to say
  anything.
- **`src/dashboard/render.ts`** — plain server-rendered HTML with no client-side JavaScript at
  all (a deliberate choice: this is a read-only ops view, not a product surface). Builds the
  stat tiles, the contract tables (`inputParams`/`outputSchema` straight from the
  `CapabilityArtifact`), the drift table, the tenant-variant table, and the cross-tenant drift
  matrix, using a small tinted-badge-plus-icon status convention so status is never carried by
  color alone.

### How

`buildCapabilityViews()` in `server.ts` is the one function that actually assembles a page:

1. `loadCapabilityCatalog("evidence/artifacts")` (from `src/artifact/catalog.ts`) returns every
   saved artifact plus its current `fingerprint`, `approvalState`, and `confidence` from the
   registry.
2. Every directory under `evidence/runs/` starting with `discovery-` is read and run through
   `computeRunMetrics` / `aggregateRunMetrics` to build the "Discovery (LLM-driven)" tile.
   (Discovery runs aren't tied to a saved artifact — there isn't one yet while discovery is
   running — so every discovery run is currently treated as activity for whatever capability
   this repo records; a multi-capability fleet version would need discovery runs to carry the
   goal/capability name they were attempting.)
3. For each artifact, `loadMatchingRunLogs(fingerprint, "evidence/runs", undefined)` (from
   `src/replay/drift-loader.ts`) finds every replay run whose logged `fingerprint` matches this
   *exact* artifact content — `undefined` tenantId means only runs of the unmodified base
   artifact count here, even if a tenant override happens to collide on fingerprint.
4. `summarizeDrift()` + `extractStepMatches()` (from `src/replay/drift.ts`) turn those matched
   run logs into the per-step drift table, and `driftAdjustedLabel()` caps the confidence badge
   (e.g. `high` → `drift-capped to medium`) if drift would otherwise leave a misleadingly
   trustworthy label unchallenged.
5. `loadTenantVariants(artifact)` (from `src/artifact/catalog.ts`) lists every
   `config/tenant-overrides/*.json` entry for this capability, and step 3–4 repeat *per tenant*
   with that tenant's own fingerprint and tenantId — this is why a tenant override shows up on
   the dashboard at all: it never exists as a file under `evidence/artifacts/`, only as an
   override layered on the base artifact plus its own replay history.
6. `render.ts`'s `crossTenantDriftMatrix()` unions the step IDs across the base artifact and
   every tenant variant that has real replay history, and renders one row per step, one column
   per surface — this is the real fleet-drift slice the report's "hundreds of tenants" vision
   describes, built honestly from however many surfaces actually exist today (currently two:
   the base app and `northgate-cu`), not a simulated fleet.

Nothing here is cached: every request re-reads `evidence/artifacts/registry.json` and every
matching file under `evidence/runs/` from scratch. That is the whole point — the page can never
go stale relative to disk, and other terminals running `replay`/`approve` concurrently can
never desync it.

### Where

- `src/dashboard/server.ts` — Express app, auth, route, `buildCapabilityViews()`
- `src/dashboard/metrics.ts` — `computeRunMetrics`, `aggregateRunMetrics`, `formatSpeedup`, `formatDuration`
- `src/dashboard/render.ts` — `renderDashboard`, `CapabilityView`, `TenantVariantView`, all the table/badge builders
- `src/artifact/catalog.ts` — `loadCapabilityCatalog`, `loadTenantVariants`
- `src/replay/drift.ts` / `src/replay/drift-loader.ts` — `summarizeDrift`, `extractStepMatches`, `driftAdjustedLabel`, `loadMatchingRunLogs`
- `src/http/api-key-auth.ts` — `requireBasicAuth` (shared with nothing else; the Capability API uses `requireApiKey` instead)
- `evidence/artifacts/` and `evidence/runs/` — the only things this page ever reads

### Worked technical example

```bash
PW=$(grep DASHBOARD_PASSWORD .env | cut -d= -f2-)
curl -s -u "operator:$PW" http://localhost:4600/ | grep -A2 "fingerprint"
```

Real output against this repo's evidence (HTML tags stripped for readability):

```
fingerprint 006fd53ee041c1ca · 18/21 clean runs · app: mock-bank
Discovery (LLM-driven)   13.9s   avg over 12 run(s) · 6.9 model calls/run
Replay (deterministic)   2.9s    avg over 22 run(s) · 0 model calls
Replay vs. discovery     4.8x faster   6.9 model call(s) avoided, every invocation
```

### Edge cases & failure modes

- **`DASHBOARD_PASSWORD` unset** — `requireBasicAuth` throws at process startup rather than
  serving the route unauthenticated; the process never comes up.
- **No artifacts under `evidence/artifacts/`** — `renderDashboard([])` renders
  `"No capability artifacts found under evidence/artifacts."` instead of an empty or broken page.
- **A discovery run's log is a single `phase: "error"` line** (a real example in this repo's
  own `evidence/runs/discovery-2026-08-25T20-26-40-212Z/log.jsonl`, from a transient Gemini
  `503`) — `computeRunMetrics` still returns a metric for it (duration ≈ 0, `llmCalls` counts
  only `decide`-phase entries, so `0` here), so one failed discovery attempt slightly dilutes
  the discovery average rather than crashing the aggregation.
- **`registry.json` is read-modify-written by other commands with no file locking**
  (documented as a known cut in `REPORT.md` §7) — the dashboard only ever reads it, so it can't
  cause the race, but a request landing mid-write by another process could in principle read a
  half-written file; not observed in practice at this system's scale.
- **Redundant confidence badges** — `confidenceBadges()` only renders the second
  "drift-capped to …" badge when it would actually change the picture, specifically to avoid a
  badge that just repeats itself next to itself.
- **Concurrent traffic while replays are in flight** — safe by construction: no shared
  mutable state in the dashboard process itself, and every request independently recomputes
  from whatever is currently on disk.

## Related docs

- [`01-system-design.md`](01-system-design.md) — where the dashboard sits in the overall module map
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — the registry and confidence score the dashboard renders
- [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — the drift signal the dashboard's UI-drift table and cross-tenant matrix are built from
- [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) — tenant overrides, rendered here as the "Tenant variants" table
- [`18-compliance-audit-export.md`](18-compliance-audit-export.md) — the other read-only, "presentation on existing evidence" addition, for a different audience
- [`../REPORT.md`](../REPORT.md) — §1 "Architecture" for the dashboard's explicit scope, §7 "Cuts" for the registry race condition
- [`../SECURITY.md`](../SECURITY.md) — HTTP Basic auth details, timing-safe comparison, fail-closed startup
- [`../README.md`](../README.md) — demo step 8, "Capability dashboard"
