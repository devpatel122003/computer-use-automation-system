# UI Drift Detection

## In one sentence

Every replay already records which "locator strategy" actually found each element on the page;
`drift-report` compares that against what was originally recorded and flags any step that's now
quietly relying on a weaker, lower-confidence way of finding things — an early warning, not a
failure, since the step is still technically succeeding.

---

## Part 1 — For everyone: noticing a coworker taking a shortcut

### The real-world analogy

Picture a coworker who's always found a specific field on a shared form by its label — "Member
ID," clearly marked. One day, without saying anything, they start finding it a different way
instead — maybe by counting boxes down from the top of the page. They're still getting the job
done; nothing has broken yet. But it's worth noticing, because that second way is more fragile:
if the form ever gets reordered, counting boxes down stops working, while reading the label
still would. Seeing them switch to the less reliable method is useful information *before*
anything actually breaks — it's an early warning sign, not yet a failure.

This system records something equivalent for every single step of every replay: not just "did
it work," but *how* it found the thing it clicked or typed into. When discovery first records a
task, each step gets an ordered list of ways to find its target, from most to least robust —
usually "by its accessible role and name" (like reading the label) first, and a structural
fallback (like counting boxes down the page) as a last resort. Every real replay logs which one
actually worked. `drift-report` is what compares "which one worked this time" against "which one
was supposed to work" and flags any mismatch.

### A concrete walkthrough, with real data from this repo

Running the drift report against this repo's own accumulated replay history right now:

```bash
npm run drift-report
```

```
Drift report: Open Sub-Account v1.0.0 (006fd53ee041c1ca)
Runs matched: 22 of 40 replay run(s) under evidence/runs

step-2 -- Type into textbox "Operator ID"
  expected: role | observed: role:21 | drift: 0/21
step-3 -- Type into textbox "Password"
  expected: role | observed: role:21 | drift: 0/21
...
step-11 -- Extract value from text "SA-00001"
  expected: text | observed: text:11, css_structural:1 | drift: 1/12  <-- DRIFT: falling back below its recorded top strategy
```

Every step from `step-2` through `step-10` resolved exactly the way it was recorded, every
single time, across 21-22 real runs each. Only `step-11` shows any drift at all — and that one
turns out to be a known, harmless false positive (below).

This same mechanism has also caught a real, non-staged problem in this project's own history:
replaying the base artifact against the rebranded `northgate-cu` tenant (see
[`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md)) *without* applying the tenant's locator
override, the `step-2`/`step-3` fields (Operator ID / Password) quietly fell back to a
structural locator instead of the recorded role-based one — because those two fields happen to
carry stable `id` attributes, so the structural fallback covered for the fact that the
role/text candidates no longer matched the rebranded page's labels. That's the same "free but
narrow resilience" limit described in [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md):
it kept the run technically working, but only because of an incidental markup detail, and
`drift-report` is exactly the tool that surfaces that kind of quiet reliance before it stops
working.

### Why `step-11` doesn't actually mean anything is wrong

`step-11` extracts the confirmation number — something like `"SA-00001"` — off the confirmation
screen. Its recorded "text" locator is the literal confirmation number that happened to be on
screen *at the moment it was recorded*. Every subsequent replay produces a *new* confirmation
number, so that exact literal text can never match again, by construction — it's not that the
page changed, it's that the value being extracted is supposed to be different every time. The
report still shows this to be transparent about it, but it's treated differently from a real
drift signal (see Part 2).

### "What happens if...?"

| Situation | What happens |
|---|---|
| A step resolves via its top-recorded strategy every time | No drift shown — it's not part of the report's flagged output at all beyond its clean counts. |
| A step quietly starts resolving via a weaker fallback strategy, but is still succeeding | Flagged with a `<-- DRIFT` marker and a count like `1/12` — a warning, since the step hasn't actually failed. |
| The fallback only works because the field happens to have a stable `id` attribute | Still flagged as drift (it's a real change from the recorded top strategy) — but it's a case worth reading closely, since it means the step is currently protected by an incidental markup detail, not a guarantee. |
| An `extract` step's recorded "text" value is itself dynamic data (like a confirmation number) | Shown in the report like any other drift, but deliberately excluded from the decision that caps an artifact's trust label — see Part 2. |
| A step has no locator at all (e.g. a `navigate` step) | Not included in the report — there's nothing to compare. |
| A step only resolved differently during an automated recovery re-run (e.g. re-login after a session timeout) | Excluded from the normal drift count — recovery re-resolving differently is a different signal than the step's *normal* first-attempt resolution drifting. |

---

## Part 2 — For engineers: why, what, how, where

### Why

`REPORT.md` originally described this signal as something the schema already supported but had
no diffing/reporting layer built for it: every action result already carries
`matchedStrategy`, so the missing piece was purely aggregation and presentation, not new data
collection. At fleet scale, this is exactly the review signal a real operations team would want:
"artifact X, tenant Y, step 6: falling back to a structural locator instead of role, 3 days
running" — something worth a human's attention before it becomes an outright failure.

### What

`src/replay/drift.ts` defines the report shape:

```ts
export interface StepDriftReport {
  stepId: string;
  description: string;
  actionType: ArtifactStep["actionType"];
  expectedStrategy: LocatorStrategy;       // the step's own top-priority candidate at record time
  observedCounts: Partial<Record<LocatorStrategy, number>>;
  totalObservations: number;
  driftCount: number;                      // observations where matched strategy != expected
}
```

### How

**Extraction.** `extractStepMatches(events)` scans one run's parsed evidence log for `act`-phase
events with `step > 0` that carry both an `action` and a `result.matchedStrategy`, and returns
`(stepNum, matchedStrategy)` pairs. It deliberately excludes recovery re-runs, which are logged
separately under `step: 0` with a different shape — a step resolving differently *during
recovery* (e.g. re-authenticating after a session timeout) is a different signal from that
step's own normal first-attempt resolution drifting, and conflating the two would make "step X
drifted" ambiguous about which invocation actually drifted.

**Aggregation.** `summarizeDrift(artifact, matches)` builds one `StepDriftReport` per step that
has a locator and at least one observation, mapping the log's numeric step position back to the
artifact's own step id (the log only records position, not id). Each observed match increments
`observedCounts[strategy]` and, if it doesn't match the step's own top-priority candidate,
increments `driftCount`.

**Loading real evidence.** `src/replay/drift-loader.ts`'s `loadMatchingRunLogs(fingerprint,
runsDir, expectedTenantId)` reads every `evidence/runs/replay-*/log.jsonl`, keeps only the runs
whose `start` event declares this exact content fingerprint, and further filters by whichever
tenant (or lack of one) the run itself declared. This tenant disambiguation exists because of a
real bug: a tenant override that changes only `baseUrlPattern` produces the *same* content
fingerprint as the base artifact (fingerprinting deliberately excludes `baseUrlPattern` — see
[`10-confidence-and-approval.md`](10-confidence-and-approval.md)), so without this check, a run
explicitly testing an unmodified base artifact against an incompatible rebranded tenant page
would silently count toward the *base* artifact's own drift signal. `loadMatchingDriftReports()`
composes extraction and aggregation for a given fingerprint.

**The label-capping decision.** `driftAdjustedLabel(rawLabel, drift)` in the same file:

```ts
export function driftAdjustedLabel(rawLabel: ConfidenceLabel, drift: StepDriftReport[]): ConfidenceLabel {
  const hasDrift = drift.some((r) => r.actionType !== "extract" && r.driftCount > 0);
  return hasDrift ? LABEL_DOWNGRADE[rawLabel] : rawLabel;
}
```

`LABEL_DOWNGRADE` maps `high → medium → low → low` (`unproven` stays `unproven`). Any
non-`extract` step with drift caps the displayed confidence one tier down — deliberately *not*
folded into `computeConfidence()`'s numeric score itself. "Did the replay engine correctly
explain what happened" and "is a step quietly relying on a fallback" are two honestly separate
signals; blending them into one number would hide which one moved.

**Why `extract` steps are excluded from the capping decision, specifically.** This wasn't a
guess — it was found live, by building the circuit breaker described in
[`10-confidence-and-approval.md`](10-confidence-and-approval.md). The very first version of that
circuit breaker also tripped for this project's own *base* artifact — not because anything was
actually wrong, but because `step-11`'s `extract` step has a permanent, harmless false positive:
its `text` locator is the literal confirmation number captured at recording time, which by
construction never matches again once a new one is issued. While drift was purely informational
(a dashboard badge), that false positive was cosmetic. The moment `driftAdjustedLabel()` started
feeding an actual enforcement gate, it silently broke the base artifact's own unattended-replay
demo. The fix is exactly the exclusion above: a `click`/`type` step's drift means the recorded
UI copy genuinely changed (a real signal); an `extract` step's drift, for a value that's dynamic
by definition, doesn't mean the UI changed at all (not a real signal). It's still shown in the
raw report for anyone who wants to see it — just excluded from the decision that caps trust.

### Where

- `src/replay/drift.ts` — pure logic: `extractStepMatches`, `summarizeDrift`, `driftAdjustedLabel` (no filesystem access, so its unit tests don't need one)
- `src/replay/drift-loader.ts` — the I/O layer on top: reads `evidence/runs/*/log.jsonl`, filters by fingerprint and declared tenant
- `src/cli/drift-report.ts` — the CLI entry point
- `src/replay/self-heal.ts` — turns a drift report into a draft override *proposal*; see below
- `src/cli/propose-override.ts` — the CLI entry point for the above
- `src/replay/execution-policy.ts` — where `driftAdjustedLabel`'s output becomes an actual gate (`effectiveAllowRisky`)
- `src/dashboard/server.ts` — renders the same signal as a badge, plus a per-tenant cross-tenant comparison table

### Self-healing proposals: closing the loop with cross-tenant reuse

Drift detection tells a human *which* steps need attention; cross-tenant reuse
([`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md)) already knows *how* to patch a
locator. Until now, connecting the two was entirely manual — read the drift-report printout,
figure out which `stepId`/`strategy` pairs need a `LocatorOverride`, hand-type the
`TenantOverride` JSON. `src/replay/self-heal.ts` + `npm run propose-override` automate the
first half of that (the *shape* of the fix) while being deliberately honest about not
automating the second half (the *content*):

```bash
npm run propose-override -- --tenant-id northgate-cu-url-only-negative-control
```

A drift report only records which locator *strategy* won and how many times — never the
actual accessible name/text that resolved. There is no honest way to fabricate a corrected
`name` from that alone; doing so would mean guessing at live DOM content this system never
observed. So `buildOverrideScaffold()` proposes exactly what it can support with real data —
one `LocatorOverride` per drifting, overridable (`role`/`text` only, matching
`LocatorOverrideSchema`'s own constraint — `css_structural`/`test_id` steps are skipped
entirely, same reasoning as [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md)'s own
narrow-override philosophy) step — with `name` left as an explicit `TODO: ...` string naming
the step and asking a human to fill it in after actually looking at the tenant's live page.

Run against this repo's own real, checked-in evidence, this reproduces the exact three-step
finding from Part 1's walkthrough (`step-2`/`step-3`/`step-5` — Operator ID, Password, Member
ID) and writes the scaffold to `config/tenant-overrides/<tenantId>.proposed.json` —
deliberately never the real `<tenantId>.json` filename `replay --tenant-override`/`approve`
would pick up, so a proposal can never be silently treated as a reviewed, trustworthy
override. The printed next step is explicit: fill in each `TODO`, save it under the real
filename, then run `npm run approve -- --tenant-override <path>` — the same propose → human
reviews → approve gate `approve.ts` already uses for artifact trust.

### A worked technical example

The output at the top of Part 1 is a real, live run of `npm run drift-report` against this
repo's own checked-in evidence (22 of 40 total replay runs matched this exact artifact
fingerprint). Every step from `step-2` through `step-10` shows zero drift across roughly 15-22
observations each; `step-11` shows `drift: 1/12`, flagged as the known extract false positive.
This is the base artifact's *own* view — it does not include the historical `step-2`/`step-3`
finding described in Part 1, because those runs declared a different tenant context and are
correctly excluded from the base artifact's own signal by the `expectedTenantId` disambiguation
described above. The dashboard's per-tenant table is where that tenant's own drift shows up on
its own row.

### Edge cases & failure modes

- **`extract`-step drift is a known, permanent false-positive category**, not just for this
  specific confirmation-number field — any step whose "text" candidate is dynamic data captured
  at recording time will drift on every subsequent run, by construction. It's real, but harmless,
  and deliberately excluded from the confidence-capping decision while still shown in the raw
  report.
- **Recovery re-runs are excluded from the normal drift signal entirely** — a step resolving
  differently mid-recovery is a different question from its own first-attempt drift.
- **Fingerprint/tenant collisions can misattribute drift**, not just confidence history — the
  same `baseUrlPattern`-exclusion issue described in
  [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) affects this signal too, and is
  specifically why `expectedTenantId` exists in the loader.
- **A step with a stable `id` attribute can mask real drift for a while.** The structural
  fallback quietly covering for a mismatched role/text candidate keeps the step succeeding, but
  it's exactly the kind of "still working, but for the wrong reason" situation this report exists
  to surface — the fix is patching the locator (via a tenant override or a re-recording), not
  ignoring the flag because the step still passes.
- **No fleet-scale aggregation across many tenants/artifacts is built** — this is documented
  explicitly as a natural extension, not a different mechanism: the same per-artifact,
  per-fingerprint logic applied to more input.

## Related docs

- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — how the drift-adjusted label becomes a real circuit breaker on unattended replay
- [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) — the tenant-override fingerprint collision this signal's loader had to account for
- [`REPORT.md`](../REPORT.md) — "Determinism & error handling" and "Stretch goals" for the full narrative, including the circuit-breaker regression this exclusion fixed
- [`README.md`](../README.md) — demo path step 7 for this exact command in context
