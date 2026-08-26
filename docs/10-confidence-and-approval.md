# Confidence & Approval

## In one sentence

Every replay of an artifact is scored against that artifact's exact recorded content, and an
artifact only earns the right to run unattended on risky steps once a human has looked at that
track record and explicitly approved it — with a second, automatic check that pulls the
privilege back if the artifact's trustworthiness later degrades.

---

## Part 1 — For everyone: earning trust, and losing it

### The real-world analogy

Think of training a new employee on a task that involves real consequences — say, opening a
bank account for a customer. The first few times they do it, a supervisor stands right next to
them and watches every step. After they've done it correctly several times in a row, the
supervisor starts trusting them to do it alone. That's earned, not assumed — nobody lets a
brand-new hire skip straight to unsupervised work on day one.

But that trust isn't permanent or unconditional. If the supervisor later notices something
seems off — a customer complaint, a small mistake, a shortcut being taken — they don't wait for
a formal review; they start watching closely again, immediately, even though the employee was
"approved" last week. And if that employee's job description changes materially — they're now
doing a meaningfully different task — the old track record doesn't carry over. They're the new
hire again, for that new task.

This system works exactly the same way for a recorded capability (an "artifact"):

- **It starts untrusted ("draft").** A freshly recorded artifact has to earn trust before it can
  run unsupervised.
- **A human watches the track record, then explicitly signs off ("approved").** Nobody flips
  this switch automatically.
- **If something later looks wrong, the system re-imposes supervision on its own** — even for an
  artifact a human already approved — rather than waiting for someone to notice and revoke it by
  hand.
- **A materially different version of the task starts over from zero trust.** It doesn't inherit
  the old version's good record.

### A concrete walkthrough, with real data from this repo

This repo has a real artifact, `open-sub-account`, whose whole point is: sign on, look up a
member, and open a new savings sub-account for them. Every time it's replayed, the outcome gets
recorded against `evidence/artifacts/registry.json`.

Run enough replays and then check in on it:

```bash
npm run approve -- --artifact evidence/artifacts/open-sub-account.artifact.json
```

```
Artifact: Open Sub-Account v1.0.0 (006fd53ee041c1ca)
Current approval state: draft
Confidence: high (8/8 clean runs)

Approved. --allow-risky will now be honored for this exact artifact content on replay.
```

That `006fd53ee041c1ca` isn't a version number a person typed in — it's a fingerprint computed
from the artifact's actual content (its steps, its inputs/outputs, its checkpoints). Before this
command ran, opening a sub-account (a real, hard-to-undo action) always required someone at the
keyboard to type `yes` at a confirmation prompt — even if you passed `--allow-risky true`, it was
silently ignored. After this command, `--allow-risky true` actually works, and the same command
runs with zero human interaction:

```bash
npm run replay -- \
  --artifact evidence/artifacts/open-sub-account.artifact.json \
  --params '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}' \
  --allow-risky true < /dev/null
```

Later, this same artifact was deliberately replayed with an `accountType` value
(`"MoneyMarket"`) that the real dropdown doesn't actually offer — a genuine, unanticipated
failure, not a staged one. The registry noticed immediately: running `approve` again on the same
artifact content showed the confidence label had actually dropped, from `high (8/8 clean runs)`
to `medium (8/9 clean runs)` — one bad run pulled the whole score down — while the artifact's
`approvalState` stayed `approved`. Nobody auto-revoked it. That's a deliberate, documented
limitation (more below), and it's why a human still needs to periodically look, or why the
system's own circuit breaker (see below) exists as a backstop.

### "What happens if...?"

| Situation | What happens |
|---|---|
| A fresh artifact, never replayed, passed to `replay --allow-risky true` | Ignored. Risky steps always prompt for confirmation on a `draft` artifact, no matter what flag was passed. |
| An artifact has 8 clean replays and gets `npm run approve` | It flips to `approved`, and the confidence score at that exact moment (`high (8/8 clean runs)`) is printed so the approval is informed, not blind. |
| An approved artifact then has a genuine failure (e.g. an unsupported account type) | The failure is recorded in its history and its confidence score drops (e.g. `high` → `medium`) — but its `approvalState` stays `approved`. It does **not** auto-revoke. |
| An approved, previously-high-confidence artifact's confidence later degrades because of UI drift (see [`12-ui-drift-detection.md`](12-ui-drift-detection.md)) | `--allow-risky` stops being honored even though the artifact is still technically `approved` — this is the confidence circuit breaker, described below. |
| Someone re-records the same task from scratch and the steps come out even slightly different | The new recording gets a different content fingerprint, so it's treated as a brand-new, unproven `draft` artifact — it does not inherit the old recording's approval or history. |
| A human decides an approved artifact shouldn't be trusted anymore | `npm run approve -- --artifact <path> --revoke true` sends it back to `draft` by hand. |
| A tenant-overridden version of the same base artifact (see [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md)) is replayed | It gets its own, independent fingerprint and its own draft/approved state — approving the base artifact does not approve the tenant variant. |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief asks for confidence scoring *and* an approval gate as if they might be separate
features. Building them separately risks the gate being decorative — an artifact could be
marked `approved` with zero evidence it ever actually worked. Tying them together, so `approve`
itself prints the confidence score at the moment of approval, makes the score load-bearing
rather than just informational.

Approval state and replay history are also deliberately **not** part of the artifact schema
itself (`src/artifact/schema.ts`). The artifact is a reviewable *contract* — steps, params,
outputs. Approval state and history are mutable, ongoing *operational data about one specific
recorded version* of that contract — closer to telemetry than to the capability's definition.
That's why they live in a separate registry file, keyed off the artifact's content rather than
stored on the artifact itself.

### What

`src/artifact/registry.ts` defines the shapes:

```ts
export type ApprovalState = "draft" | "approved";
export type ReplayOutcomeStatus = "success" | "business_outcome" | "failure";

export interface ReplayHistoryEntry {
  runId: string;
  timestamp: string;
  status: ReplayOutcomeStatus;
}

export interface ArtifactRegistryEntry {
  artifactId: string;
  version: string;
  fingerprint: string;
  approvalState: ApprovalState;
  history: ReplayHistoryEntry[]; // capped at MAX_HISTORY = 50
}

export interface ConfidenceScore {
  totalRuns: number;
  successCount: number;
  hardFailureCount: number;
  score: number; // (success + business_outcome) / total
  label: "unproven" | "low" | "medium" | "high";
}
```

`computeConfidence()` treats `success` and `business_outcome` identically as "the artifact did
its job correctly" — including correctly reporting a legitimate business answer like "no such
member." Only `failure` (the replay engine genuinely couldn't explain what happened) counts
against the score. This deliberately reuses the same three-way outcome split the replay engine
already produces (see [`06-deterministic-replay.md`](06-deterministic-replay.md)) rather than
inventing a second notion of "worked."

Label thresholds, from the source:

```ts
if (totalRuns >= 5 && score >= 0.95) label = "high";
else if (totalRuns >= 2 && score >= 0.7) label = "medium";
else label = "low"; // (or "unproven" if totalRuns === 0)
```

Requiring at least two runs for `medium` (not just a score threshold) is a shallow guard against
a single lucky or misclassified run alone producing a "trustworthy-looking" label.

### How

**Fingerprinting.** `fingerprintArtifact()` builds a stable object from exactly the fields that
define *behavior* — `id`, `target.appId`/`surfaceType`, `inputParams`, `outputSchema`, `steps`,
`successCheckpoint`, `knownOutcomes` — deliberately excluding cosmetic fields like `createdAt`
and, notably, `target.baseUrlPattern` (so a re-recording pointed at a different environment
still shares history, rather than starting a new, unearned track record purely because of where
it's deployed). A `canonicalize()` pass deep-sorts object keys first, so a hand-built object and
the same data re-parsed through Zod produce byte-identical JSON regardless of property
insertion order — otherwise `JSON.stringify` would make the fingerprint unstable for reasons that
have nothing to do with actual content. The result is SHA-256'd and truncated to 16 hex
characters.

**Registry keying.** `getOrCreateEntry()` looks up (or creates) an entry keyed by
`` `${artifactId}@${fingerprint}` ``, not just `id`+`version`. A materially different
re-recording of the same `id` gets a different fingerprint and therefore a fresh `draft` entry
with an empty history — it cannot silently inherit a prior version's approval or confidence.

**Persisting outcomes.** `recordReplayOutcome()` appends one `ReplayHistoryEntry` per replay and
trims to the most recent 50. `loadRegistry()`/`saveRegistry()` read/write
`evidence/artifacts/registry.json` as plain JSON; a truncated or corrupted file (e.g. from a
killed process) is treated as an empty registry rather than crashing every future run.

**The approve CLI** (`src/cli/approve.ts`): loads the artifact (optionally applying a tenant
override first via `--tenant-override <path>`, since an overridden artifact only ever exists
in-memory and needs its own approvable identity — see
[`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md)), gets or creates its registry entry,
prints the current confidence, and either sets `approvalState` to `"approved"` or, with
`--revoke true`, back to `"draft"`. If the artifact has zero recorded runs, it still lets you
approve it, but warns explicitly that doing so means its first unattended production run would
also be its first real test.

**The confidence circuit breaker** (`src/replay/execution-policy.ts`) is the second, independent
gate on top of approval:

```ts
export function effectiveAllowRisky(params: {
  requestedAllowRisky: boolean;
  approvalState: ApprovalState;
  driftAdjustedLabel: ConfidenceLabel;
}): boolean {
  if (!params.requestedAllowRisky) return false;
  if (params.approvalState !== "approved") return false;
  return params.driftAdjustedLabel === "medium" || params.driftAdjustedLabel === "high";
}
```

Until this existed, `approvalState === "approved"` was the *only* gate on unattended execution —
an artifact approved once stayed unattended-eligible forever, even if its confidence, adjusted
for UI drift (`driftAdjustedLabel()`, see [`12-ui-drift-detection.md`](12-ui-drift-detection.md)),
later degraded to `low` or `unproven`. Now an `approved` artifact whose drift-adjusted confidence
has slipped falls back to attended confirmation for its risky steps regardless of what
`--allow-risky` was passed — deliberately reusing the same tier labels `driftAdjustedLabel()`
already produces (`unproven`/`low`/`medium`/`high`) rather than inventing a second threshold
scale to keep in sync. Both `replay` and the capability API (`src/api`) and `canary-check` call
this same function — there's no separate, looser path for any of them.

### Where

- `src/artifact/registry.ts` — fingerprinting, registry storage, confidence math
- `src/replay/execution-policy.ts` — `effectiveAllowRisky()`, the circuit breaker
- `src/cli/approve.ts` — the CLI for viewing confidence and flipping approval state
- `evidence/artifacts/registry.json` — the on-disk registry, one entry per `artifactId@fingerprint`
- `src/replay/replay-engine.ts` and `src/api` — callers that both read and update the registry on every replay

### A worked technical example

```bash
npm run approve -- --artifact evidence/artifacts/open-sub-account.artifact.json
```
```
Artifact: Open Sub-Account v1.0.0 (006fd53ee041c1ca)
Current approval state: draft
Confidence: high (8/8 clean runs)

Approved. --allow-risky will now be honored for this exact artifact content on replay.
```

Then, once a genuine failure entered the same fingerprint's history (a real replay with an
unsupported `accountType`), re-running `approve` on the same content reported the score moving,
without any code change and without the approval state itself changing:

```
Current approval state: approved
Confidence: medium (8/9 clean runs)
```

### Edge cases & failure modes

- **No auto-demotion.** An approved artifact never automatically drops back to `draft` on its
  own, even after real failures accumulate in its history — only `--revoke true` does that. The
  drift-adjusted circuit breaker (above) is the one automatic backstop that exists today, and it
  only affects `--allow-risky`, not the stored `approvalState` value itself.
- **No reviewer identity.** The registry records *that* something was approved and *when*
  (implicitly, by when the file was last written), not *who* approved it. A real multi-operator
  deployment would need that; see `REPORT.md` "Cuts" and `SECURITY.md`.
- **Trusts the replay engine's own classification.** Confidence is built entirely from the
  replay engine's own `success`/`business_outcome`/`failure` verdicts. If an artifact's
  `knownOutcomes` detector were systematically wrong — too loose, matching pages it shouldn't —
  every run would be misclassified as a clean `business_outcome`, and confidence would climb
  regardless of whether the artifact actually still works correctly. The `medium` tier's
  two-run minimum only guards against a single fluke, not a *systematic* misclassification
  replayed many times. Closing that gap for real would need either detector review as part of
  `approve`, or periodic human spot-checks of `business_outcome` runs against something outside
  the system's own say-so — neither is built.
- **Registry corruption is tolerated, not surfaced.** A truncated `registry.json` silently
  becomes an empty registry rather than erroring — safe for availability, but it means a
  corrupted file quietly forgets an artifact's entire track record instead of raising an alarm.
- **Fingerprint collisions across tenant overrides.** Because the fingerprint deliberately
  excludes `baseUrlPattern`, a tenant override that changes *only* the URL (no locator/checkpoint
  patches) collides with the base artifact's own fingerprint — a real issue documented in
  [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md).

## Related docs

- [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) — why a tenant-overridden artifact gets its own independent registry entry
- [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — the drift-adjusted label that feeds the confidence circuit breaker
- [`17-multi-run-stability.md`](17-multi-run-stability.md) — the recent-window health signal built on top of this same history
- [`REPORT.md`](../REPORT.md) — "Stretch goals: Confidence & approval" for the full design narrative and real evidence
- [`README.md`](../README.md) — demo path step 5 and step 10 for these exact commands in context
