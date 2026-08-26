# Compliance & Audit Export

## In one sentence

A command that turns the same already-redacted evidence every discovery and replay run writes
anyway into a Markdown report formatted for a bank's compliance/audit function specifically —
not a developer — because the brief says plainly, of the data this system touches, "this is
regulated financial data."

---

## Part 1 — For everyone: the end-of-shift report for auditors

### The analogy

Picture a bank branch at closing time. Nothing new happens because closing time arrives — no
new deposits, no new loans — but the branch manager still has to sit down and produce a report
for the bank's own auditors: how many transactions happened today, how many required a second
person's sign-off, how many of those were approved versus declined, and a record of each one.
The manager isn't doing any new banking; they're organizing what already happened into the
exact shape an auditor needs to review it.

The compliance/audit export is that end-of-shift report for this system. It does not run any
new discovery, replay any capability, or touch a live banking screen. It reads the run logs
that already exist on disk and writes them out in the format a compliance reviewer — someone
whose job is auditing, not debugging code — actually needs.

### A concrete walkthrough, with real output from this repo

```bash
npm run compliance-report -- --out compliance-report.md
```

Run against this repo's own accumulated evidence (52 runs), the real generated report starts:

```markdown
# Compliance Audit Report

Generated: 2026-08-26T04:35:07.873Z
Covers 52 run(s) currently in evidence/runs.

> **Limitation, disclosed rather than hidden:** this system does not currently record
> *which human* approved a risky action or an artifact (see REPORT.md §7) -- only
> *that* an action was approved/declined and when. A real deployment auditing against
> this report would still need an authenticated-reviewer identity layer on top.

## Summary

- Discovery runs: 12 · Replay runs: 40
- Risky actions requiring confirmation: 14 total, 11 approved, 3 declined
- Outcomes: finished (7), success (20), business_outcome (5), escalated (1), failure (10),
  incomplete (no result recorded -- run may have crashed or been interrupted) (9)
```

And then one detail entry per run, for example:

```markdown
### `replay-2026-08-14T20-30-52-039Z`

- Type: replay
- Started: 2026-08-14T20:30:52.040Z · Ended: 2026-08-14T20:30:54.876Z
- Capability: open-sub-account
- Artifact fingerprint: `006fd53ee041c1ca`
- Outcome: **success**
- Risky actions:
  - ✓ approved — Step step-10: Click button "Submit"
- Evidence: `evidence/runs/replay-2026-08-14T20-30-52-039Z`
```

...and, elsewhere in the same real report, a run where the risky action was declined instead
(against the `northgate-cu` tenant variant):

```markdown
### `replay-2026-08-25T20-03-59-895Z`

- Type: replay
- Capability: open-sub-account
- Artifact fingerprint: `3916eebec9394f52`
- Tenant: northgate-cu
- Outcome: **failure**
- Risky actions:
  - ✗ declined — Step step-10: Click button "Submit"
```

Notice what's *not* in either entry: no member ID, no password, no dollar amount. Every field
in the report was already safe to show before the report was ever generated — the export just
picks fields out of evidence that was redacted at write time, it doesn't decide what's safe on
its own.

### "What happens if...?"

| Situation | What happens |
|---|---|
| No runs exist yet under `evidence/runs/` | The report still generates — "Covers 0 run(s)" and an empty summary, not an error. |
| A run crashed before writing its result file | It still gets a detail entry, with outcome `"incomplete (no result recorded -- run may have crashed or been interrupted)"` — a real example of this exists in this repo's own evidence (`replay-2026-08-25T20-03-13-057Z`, a `northgate-cu` run). |
| A risky action was declined rather than approved | It's recorded as `✗ declined`, not omitted — the report is a factual record of what happened, not just of the successful path. |
| An auditor asks "who specifically approved this risky action?" | The report's own header answers that directly: this system records *that* an action was approved and *when*, not *which human* clicked approve. That's stated as a disclosed limitation, not left implicit. |
| You run it with `--out` vs. without | `--out compliance-report.md` writes the file and prints a one-line confirmation; omitting `--out` prints the whole report to stdout instead. |
| You point it at a different evidence tree | `--runs-dir <path>` reads from anywhere, not just the default `evidence/runs` — useful for auditing an archived set of runs pulled off a production system. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Not one of the brief's six named Section 8 stretch goals. Stated directly in `REPORT.md`: this
is presentation on existing evidence, the same category as the dashboard, not new business
logic. It exists because the brief itself licenses it — "this is regulated financial data" —
and because nothing else in this repo addresses a compliance/audit reader specifically: the
dashboard is for an operator, the drift report is for an engineer, and neither is the shape a
bank's audit function actually needs to review.

### What

Two files:

- **`src/evidence/audit-report.ts`** — the pure logic. `buildRunAuditEntry(runId, events,
  resultJson, evidenceDir)` turns one run's already-parsed log events and result JSON into a
  `RunAuditEntry`; `renderAuditReportMarkdown(entries, generatedAt)` turns a list of those into
  the Markdown report shown above.
- **`src/cli/compliance-report.ts`** — the thin CLI wrapper: walks `evidence/runs/` (or
  `--runs-dir`), reads each run's `log.jsonl` and its `replay-result.json` /
  `discovery-result.json` if present, calls the two functions above, and either prints the
  result or writes it to `--out`.

Key shapes, from `audit-report.ts`:

```ts
export interface RiskyActionRecord {
  context: string;   // the confirmation prompt's own reason text -- names the route/step, never a secret
  approved: boolean;
}

export interface RunAuditEntry {
  runId: string;
  runType: "discovery" | "replay";
  startedAt: string;
  endedAt: string;
  capabilityLabel: string;   // an artifact name for replay, the redacted goal string for discovery
  tenantId?: string;
  fingerprint?: string;
  outcome: string;
  riskyActions: RiskyActionRecord[];
  evidenceDir: string;
}
```

### How

`buildRunAuditEntry` is deliberately a **pure function** — no filesystem access at all, which
is what makes it unit-testable without a real `evidence/` tree. It:

1. Infers `runType` from the run ID's own prefix (`discovery-` vs. anything else).
2. Finds the run's `phase: "start"` log event for `startedAt`/basic context, and every
   `phase: "escalation"` event whose `detail.approved` is a boolean — those become
   `RiskyActionRecord`s, with `context` read from `detail.reason` (e.g. `"Step step-10: Click
   button \"Submit\""` — a step description, never a raw parameter value).
3. Builds `capabilityLabel`: for discovery, the (already-redacted) `goal` string from the start
   event's detail; for replay, the artifact ID from whichever `start` event carries an
   `artifactId` field (there are two `start` events per replay run — one from the capability
   API invocation if it came through there, one from the replay engine itself).
4. Reads `fingerprint` and `tenantId` (from `detail.tenantOverride.tenantId`) off the replay
   start event when present.
5. Reads `outcome` from the result JSON's `status` field, falling back to the literal string
   `"incomplete (no result recorded -- run may have crashed or been interrupted)"` when no
   result file exists — a run that crashed mid-flight still gets a truthful entry instead of
   being silently dropped.

`renderAuditReportMarkdown` then sorts entries by `startedAt`, computes the summary counts
(discovery vs. replay counts, risky-action approved/declined totals, an outcome histogram), and
emits one `###` section per run. `escapeMd()` escapes Markdown special characters
(`|`, `` ` ``, `*`, `_`, `[`, `]`) in any free-text field before it goes into the report — since
a discovery goal string is user-supplied text, this stops it from accidentally breaking the
report's own table/list formatting or injecting unintended Markdown structure.

Crucially: **this module never re-derives or re-touches a raw parameter.** Every value it reads
was already passed through `src/guardrails/redaction.ts` at the moment the original run's
logger wrote it (see the `password` field showing up as `"[REDACTED]"` in the raw
`log.jsonl`, never as plaintext). The compliance report is a second read of already-safe data,
not a second chance to leak something the first pass protected.

### Where

- `src/evidence/audit-report.ts` — `buildRunAuditEntry`, `renderAuditReportMarkdown`, `RunAuditEntry`, `RiskyActionRecord`
- `src/cli/compliance-report.ts` — CLI entry point, `--runs-dir` / `--out` args
- `src/guardrails/redaction.ts` — where the safety this module relies on actually happens (upstream, at write time)
- `evidence/runs/*/log.jsonl`, `evidence/runs/*/replay-result.json`, `evidence/runs/*/discovery-result.json` — the only inputs
- `package.json` — `"compliance-report": "tsx src/cli/compliance-report.ts"`

### Worked technical example

```bash
npm run compliance-report -- --out compliance-report.md
```

Real output:

```
Compliance audit report written to compliance-report.md (52 run(s)).
```

And the real summary line from that same run:

```
- Discovery runs: 12 · Replay runs: 40
- Risky actions requiring confirmation: 14 total, 11 approved, 3 declined
- Outcomes: finished (7), success (20), business_outcome (5), escalated (1), failure (10),
  incomplete (no result recorded -- run may have crashed or been interrupted) (9)
```

### Edge cases & failure modes

- **A run directory exists but its `log.jsonl` is empty or missing** — `buildRunAuditEntry`
  returns `null` for it, and the CLI filters those out before rendering; an empty run
  contributes nothing rather than a broken entry.
- **A run crashed before any result file was written** — `readResultJson` returns `undefined`,
  and `outcome` falls back to the disclosed `"incomplete (...)"` string rather than guessing a
  status.
- **A discovery run has no fingerprint or tenant** — both fields are simply omitted from that
  entry (`tenantId`/`fingerprint` are optional on `RunAuditEntry`); only replay runs against a
  tenant-overridden artifact carry a `tenantId`.
- **The one limitation this system discloses about itself, in its own generated output**: no
  per-approver identity. `approve`/the confirmation-prompt flow record *that* a risky action or
  artifact was approved and *when*, never *by whom* — anyone with access to run the CLI can
  approve something. This is named directly in the report's own header (not just in this doc or
  `REPORT.md`), specifically so a reviewer reading the report itself, without any other
  context, still gets the honest caveat.
- **A discovery goal string containing Markdown-special characters** (`*`, `_`, `` ` ``, `|`,
  `[`, `]`) — escaped via `escapeMd()` before being embedded, so it can't corrupt the report's
  own formatting.
- **This report is not itself access-controlled** — unlike the dashboard (HTTP Basic) or the
  capability API (bearer key), `compliance-report` is a local CLI command that writes a plain
  file; whatever file-system permissions protect the rest of this repo's evidence protect this
  output too, and nothing more.

## Related docs

- [`16-dashboard.md`](16-dashboard.md) — the other "presentation on existing evidence" addition, same category, different audience
- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — where the risky-action confirmation this report summarizes actually happens
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — the approval state this report's disclosed limitation also applies to
- [`../REPORT.md`](../REPORT.md) — §6 "Safety", §7 "Cuts" (no per-approver identity), and "A non-stretch-goal addition: compliance audit export"
- [`../SECURITY.md`](../SECURITY.md) — the redaction and auth this report's own safety depends on
- [`../README.md`](../README.md) — demo step 15, "Compliance/audit export"
