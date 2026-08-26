# Evidence & Logging

## In one sentence

Every run — discovery or replay, success or failure — writes a structured, line-by-line
record of exactly what it observed, decided, did, and checked, plus a screenshot whenever
something goes wrong or a human gets called in, so anyone can find out what actually happened
without having to re-run anything or just trust a status line.

---

## Part 1 — For everyone: a flight data recorder for the automation

### The real-world analogy

An airplane's black box doesn't just record when something goes wrong — it's writing down
altitude, speed, and control inputs the entire flight, every single time, whether the flight
is completely uneventful or not. Nobody has to just take the pilot's word for it that a flight
went fine; the recording is there either way. And on the rare flight where something *did* go
wrong, investigators don't need to guess — they can read exactly what the instruments showed,
second by second, leading up to the moment.

That's exactly what `src/evidence/` does for this system. Every discovery run and every replay
run — whether it ends in a clean success, a normal "no such member" answer, or a genuine
failure — gets its own folder with a complete, ordered, line-by-line log of everything that
happened, plus screenshots at the moments that matter most (failures, escalations). Nobody has
to trust a "finished with status: success" printout on faith; the evidence is right there to
check, and it was already being written *before* anyone knew whether the run would succeed.

### A concrete walkthrough

Take a real run already sitting in this repo,
`evidence/runs/replay-2026-08-26T00-40-07-082Z/` (the member-77777 escalation-resume replay
covered in [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md)). Its folder
contains:

```
evidence/runs/replay-2026-08-26T00-40-07-082Z/
├── log.jsonl                  (one JSON line per event, in order)
├── intervention-1.json        (the escalation request that paused this run)
├── replay-result.json         (the final structured outcome)
└── screenshots/
    ├── 001-checkpoint-failed-step-10.png
    └── intervention-1.png
```

Opening `log.jsonl` and reading it top to bottom tells the entire story of the run without
needing to re-run anything: it signed on, searched for member 77777, opened the sub-account
form, filled it in, clicked Submit, landed somewhere the recorded artifact didn't expect, paused
for a human, got a "resume," rechecked and found things were already fine, extracted a real
confirmation number `SA-00001`, and succeeded. Every single one of those is one line in the
log, in the order it actually happened, each stamped with a real timestamp — for example:

```json
{"ts":"2026-08-26T00:40:10.478Z","step":10,"phase":"checkpoint","summary":"Checkpoint for step-10: failed","detail":{"checkpoint":{"kind":"url","expr":"/members/{memberId}/sub-accounts/*/confirm","description":"Reached the sub-account confirmation page."}}}
```

And `intervention-1.json` records exactly what the automation was stuck on, when, and where:

```json
{
  "runId": "replay-2026-08-26T00-40-07-082Z",
  "runType": "replay",
  "capability": "Open Sub-Account",
  "step": "step-10",
  "reason": "Checkpoint failed at step-10: Reached the sub-account confirmation page.",
  "screenshotPath": ".../screenshots/intervention-1.png",
  "url": "http://localhost:4000/members/77777/sub-accounts",
  "createdAt": "2026-08-26T00:40:10.549Z"
}
```

### Why this matters even when nothing goes wrong

If evidence were only written on failure, you'd only ever be able to investigate the runs that
already went badly — which is exactly backwards for building trust in an automated system.
Because every run writes the same evidence regardless of outcome, you can also answer
questions like "how many times has this exact artifact been run successfully?" (the
confidence/approval registry, `evidence/artifacts/registry.json`, is built entirely from this
same evidence) or "what did a *successful* run's password field actually contain in the log?"
(nothing — see redaction below) — without ever needing a special "debug mode."

### "What happens if...?" — real scenarios

| Situation | What happens |
|---|---|
| A run succeeds cleanly, no drama at all | Still gets a full `log.jsonl`, still gets a `discovery-result.json` / `replay-result.json`, same as any other run — success isn't a reason to write less. |
| A step fails outright (e.g. requesting an account type the dropdown doesn't offer) | A screenshot is taken (`00N-failure-<stepId>.png`) before the run reports `failure`, so you can literally see what the page looked like at the moment it broke. |
| A human is escalated to | A screenshot, a numbered `intervention-N.json` file, and `phase: "escalation"` log lines both requesting and later resolving the intervention — see [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md). |
| A password or other secret value passes through an action (e.g. typing into a Password field) | It's registered with the logger (`addSensitiveValue`) and every occurrence of that exact string, anywhere in any future log line or JSON file — under any field name — is replaced with `[REDACTED]`. |
| An SSN- or credit-card-shaped string shows up anywhere in evidence, even in a field nobody flagged | Scrubbed anyway, as defense in depth, by pattern (`[REDACTED-SSN]`, `[REDACTED-NUMBER]`) — not dependent on some developer remembering to flag that specific field. |
| Someone wants to know if a given artifact is trustworthy enough to run unattended | The confidence/approval registry answers that from the same evidence every run already wrote — no separate tracking system. |
| A bank's compliance/audit team wants a report of what happened, without reading raw JSON logs | `npm run compliance-report` reformats the same already-redacted evidence into a readable report — it never re-derives or re-touches raw params, only reads what was already safe to read. |
| Evidence for a run needs to be reviewed a month later, when nobody remembers the details | Nothing needs to be re-run — the full ordered log, screenshots, and final result are all still sitting on disk exactly as written. |

---

## Part 2 — For engineers: why, what, how, where

### Why

A system that can't produce evidence of what it actually did is not auditable, not debuggable
without re-running (which may not even reproduce the same real-world conditions, e.g. a
member's account state), and not something a bank's compliance function could ever sign off
on. The brief explicitly frames the target data as "regulated financial data" — so evidence
has to be genuinely safe to look at (no plaintext secrets ever), and genuinely complete (every
phase of every run, not just the failures).

### What

- `src/evidence/logger.ts` — the whole logging mechanism:
  - `EventPhase = "start" | "observe" | "decide" | "act" | "checkpoint" | "outcome" | "escalation" | "error" | "end"`
  - `LogEvent { ts: string; step: number; phase: EventPhase; summary: string; detail?: Record<string, unknown> }`
  - `class EvidenceLogger` — constructed with `{ runId, runType, baseDir?, sensitiveKeys? }`;
    exposes `runDir`, `screenshotsDir`, and the methods `log()`, `writeJson()`,
    `addSensitiveKeys()`, `addSensitiveValue()`.
  - `newRunId(runType: "discovery" | "replay"): string` — e.g.
    `replay-2026-08-26T00-40-07-082Z`, an ISO timestamp with `:`/`.` swapped for `-` so it's a
    valid filename.
- `src/guardrails/redaction.ts` — `redact()`, `scrubString()`, the `RedactOptions` shape
  (`sensitiveKeys`, `sensitiveValues`, `keyHint`), applied to *every* `log()` and `writeJson()`
  call before anything touches disk.
- `src/evidence/audit-report.ts` — `buildRunAuditEntry()`, a pure function (no filesystem
  access) that turns one run's already-redacted events + result JSON into a
  `RunAuditEntry` for the compliance report; never re-derives raw params.
- The directory layout under `evidence/`:
  ```
  evidence/
  ├── runs/<runId>/
  │   ├── log.jsonl                 -- one JSON line per LogEvent, appended in real time
  │   ├── screenshots/               -- 001-<label>.png, 002-<label>.png, ... in call order
  │   ├── intervention-N.json        -- one per escalation raised during this run
  │   └── discovery-result.json      -- or replay-result.json; the run's final structured outcome
  └── artifacts/
      ├── <capability-name>.artifact.json   -- a saved, versioned capability artifact
      └── registry.json                     -- confidence + approval state per artifact fingerprint
  ```

### How

**Construction and layout.** `new EvidenceLogger({ runId, runType })` immediately creates
`evidence/runs/<runId>/screenshots/` (`fs.mkdirSync(..., { recursive: true })`) and truncates
`log.jsonl` to empty — so even a run that crashes on its very first line leaves a real, if
short, evidence trail rather than nothing.

**Every event, one line, append-only.**
```ts
log(event: Omit<LogEvent, "ts">): void {
  const full: LogEvent = { ts: new Date().toISOString(), ...event };
  const redacted = redact(full, { sensitiveKeys: this.sensitiveKeys, sensitiveValues: this.sensitiveValues }) as LogEvent;
  fs.appendFileSync(this.logPath, `${JSON.stringify(redacted)}\n`);
}
```
JSONL (one complete JSON object per line, no enclosing array) rather than one big JSON array
specifically because it's append-only and streamable — a run in progress has a valid,
parseable log at every point, not just after it finishes and someone remembers to close a
bracket.

**Redaction happens on every write, not just some.** `writeJson()` (used for
`discovery-result.json`/`replay-result.json` and every `intervention-N.json`) redacts exactly
the same way `log()` does, so there's no second, unguarded path to disk:
```ts
writeJson(filename: string, data: unknown): string {
  const filePath = path.join(this.runDir, filename);
  const redacted = redact(data, { sensitiveKeys: this.sensitiveKeys, sensitiveValues: this.sensitiveValues });
  fs.writeFileSync(filePath, JSON.stringify(redacted, null, 2));
  return filePath;
}
```

**Redaction itself, `src/guardrails/redaction.ts` (see also
[`07-guardrails-and-safety.md`](07-guardrails-and-safety.md)):**
- **By key name.** `SENSITIVE_KEY_PATTERN = /password|secret|token|ssn|social_security|credit_?card|cvv|\bpin\b/i` masks a field's *entire* value outright, whatever shape that value has (string, number, nested object) — checked before any type-specific handling, so a numeric PIN or a nested `{ password: { value: "..." } }` can't slip through.
- **By known value.** Callers register concrete secrets as they become known (e.g.
  `logger.addSensitiveValue(PASSWORD)` right after the CLI reads a password param) via
  `addSensitiveValue()`; every future log line or JSON file has every occurrence of that exact
  string replaced with `[REDACTED]`, regardless of which field it's nested under — needed
  because a password can flow through a generically-named field like an action's `text`.
  A `MIN_SCRUBBABLE_VALUE_LENGTH = 6` floor deliberately skips this substring scan for very
  short values, so a short/weak secret can't cause **over-redaction** by coincidentally
  matching part of an unrelated member ID or dollar amount elsewhere in the same line.
- **By pattern, everywhere, as defense in depth.** `scrubString()` regex-matches SSN-shaped
  (`\d{3}-\d{2}-\d{4}`) and card-number-shaped (13–19 digit) strings in *any* string value and
  masks them, independent of key name or prior registration — catching sensitive-looking data
  nobody explicitly flagged.

**Screenshots.** `PlaywrightSurface.screenshot(label)` (`src/surface/playwright-surface.ts`)
maintains its own per-run counter and writes `<NNN>-<label>.png` into `evidenceDir`
(`logger.screenshotsDir`), e.g. `001-checkpoint-failed-step-10.png`. Escalation intervention
screenshots are written the same way but named directly by intervention count
(`intervention-1.png`, `intervention-2.png`, ...) rather than through the shared counter, since
they're triggered from `EscalationController`, not from the step-execution loop.

**The registry.** `evidence/artifacts/registry.json` is keyed by
`<artifactId>@<fingerprint>` and holds `{ artifactId, version, fingerprint, approvalState, history: [{ runId, timestamp, status }] }` — built up purely from replay outcomes recorded after
every run (`recordReplayOutcome`), which is itself just reading the same evidence every run
already produces, not a separately-maintained metric. See
[`10-confidence-and-approval.md`](10-confidence-and-approval.md) for how confidence is computed
from this history.

### A worked technical example

```bash
cat evidence/runs/replay-2026-08-26T00-40-07-082Z/log.jsonl | tail -5
```

```json
{"ts":"2026-08-26T00:40:11.109Z","step":10,"phase":"escalation","summary":"Operator resolved intervention with: resume","detail":{"decision":"resume"}}
{"ts":"2026-08-26T00:40:11.110Z","step":10,"phase":"checkpoint","summary":"Post-escalation checkpoint recheck for step-10: already satisfied"}
{"ts":"2026-08-26T00:40:11.142Z","step":11,"phase":"act","summary":"Performed extract (step-11): ok","detail":{"action":{"type":"extract","target":[{"strategy":"text","name":"SA-00001","nth":0,"confidence":"medium"}]},"result":{"ok":true,"matchedStrategy":"text","extractedValue":"SA-00001","url":"http://localhost:4000/members/77777/sub-accounts/SA-00001/confirm"}}}
{"ts":"2026-08-26T00:40:11.143Z","step":12,"phase":"checkpoint","summary":"Success checkpoint: passed"}
{"ts":"2026-08-26T00:40:11.143Z","step":12,"phase":"outcome","summary":"Replay succeeded","detail":{"outputs":{"confirmationNumber":"SA-00001"}}}
```

Note the password typed at step 2/3 of this same log shows up as `"text":"[REDACTED]"`, never
in the clear — confirmed directly in the checked-in log, not asserted.

To see the compliance-facing view of this same evidence:

```bash
npm run compliance-report -- --out compliance-report.md
```

which walks every run under `evidence/runs/`, builds a `RunAuditEntry` per run via
`buildRunAuditEntry()`, and writes a human-readable report — reading only data that was
already redacted at write time.

### Edge cases & failure modes

- **A run crashes before writing a result file.** `log.jsonl` still exists (truncated to empty
  at construction, then appended to as events occur), so partial evidence survives even a
  hard crash; `audit-report.ts` explicitly handles this case, marking such a run's outcome as
  `"incomplete"` rather than failing to build an entry at all.
- **A screenshot fails to capture** (e.g. the page is mid-navigation). Caught and logged as a
  `phase: "error"` event; does not stop the run or the rest of the logging.
  path — `evidence/runs/<runId>/screenshots/<N>-<label>.png`, so the reference is meaningful
  even if the reader never runs the code that produced it.
- **A secret value is too short to be safely substring-scrubbed** (under
  `MIN_SCRUBBABLE_VALUE_LENGTH`). Key-based redaction still fully masks it if it's stored
  under a recognized field name; only the blind whole-string scan is skipped, specifically to
  avoid over-redacting unrelated legitimate data (a member ID, a dollar amount) that happens to
  contain the same short digit sequence.
- **A value's key name looks sensitive but the value itself is, say, a number or nested
  object.** Still fully masked — the key-name check runs before any type-specific branch,
  specifically to avoid the bug this comment in the source calls out directly: an earlier
  version only checked this inside the string branch, so a numeric PIN or a nested secret
  object went out un-redacted.
- **Something writes evidence outside `EvidenceLogger`'s `log()`/`writeJson()` methods.** There
  is no such path in this codebase today — every write goes through one of these two methods,
  which is precisely what guarantees redaction can't be silently bypassed.

## Related docs

- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — the intervention records
  and screenshots this doc describes are what an escalation actually writes
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the allowlist/risk-checking
  layer that shares the same redaction utility
- [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — how the registry under
  `evidence/artifacts/` is built entirely from this same evidence
- [`21-testing-strategy.md`](21-testing-strategy.md) — why real, checked-in evidence runs
  substitute for mocking a real browser or a real LLM in this project's test suite
- [`REPORT.md`](../REPORT.md) — "Escalation & handoff" and the compliance/audit export section
- [`SECURITY.md`](../SECURITY.md) — the broader secrets/redaction posture this logger
  implements
