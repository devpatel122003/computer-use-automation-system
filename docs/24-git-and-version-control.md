# Git and Version Control

## In one sentence

Git is the tool that saves a complete, permanent history of every change ever made to this
project's files — what changed and, in a good commit message, *why* — and this project
keeps that whole history on one single branch, `main`, on purpose, because it's a small,
single-contributor project where splitting work across many branches would add overhead
this project's actual size doesn't need to pay for.

---

## Part 1 — For everyone: what is Git, and why does this project only have one branch?

### The analogy: "track changes," but for an entire project, forever

You may have used "track changes" in a word processor: it remembers every edit made to a
document, who made it, and lets you see exactly what the document looked like at any earlier
point. **Git is that same idea, applied to an entire project's worth of files at once** — not
just one document, but every source file, every config file, every doc, tracked together, as
one evolving whole. Every time you save a meaningful checkpoint (called a **commit**), Git
records exactly what changed since the last checkpoint, along with a short note (the
**commit message**) explaining what happened and, ideally, *why*. Unlike "undo" in a word
processor, this history never gets thrown away when you close the file — it's permanent,
and you can go back and look at (or even restore) any past version, forever.

**GitHub** is a website that hosts a copy of this history online, so it can be viewed,
shared, and — for a team — worked on by more than one person at once. This project's history
lives on GitHub because the take-home brief asks for the project to be shared there.

A **branch** is a named, separate line of work within that same history — think of it as a
"parallel draft" you can experiment in without touching the version everyone else is
relying on, then merge back in once you're confident it's good. Lots of real projects use
many branches (one per feature, so several people can work at once without stepping on each
other). This project uses exactly one: `main`. That's a deliberate choice, explained below,
not an oversight.

### A concrete walkthrough, using this project's real history

Running `git log --oneline` in this repo's real history shows commits like these (most
recent first):

```
3970c80 registry.json
9616255 Add mid-artifact resume for replay hard failures, fix a resume/abort ambiguity on closed stdin
33906b6 Fix escalation-prompt hang on closed stdin and a wrong decline message; add demo runbook
8178b2c Add Gemini daily-quota fallback across models, fix assisted-recovery ignoring GEMINI_MODEL
08556d6 Document the production-hardening pass: auth, containers, CI, architecture
ba1e6f6 Containerize the three long-running services and add CI
8de5331 Add real authentication and fix a path-traversal bug in the capability API
5dea14a Fix critical/major issues from adversarial review; regenerate evidence and docs
450cf63 Computer-use automation system: discovery agent, capability artifacts, deterministic replay
```

Read top to bottom (newest to oldest), this list is a genuine, readable record of how the
project actually grew: it started as a working core system (`450cf63`), was adversarially
reviewed and had real issues fixed (`5dea14a`), later gained authentication and a
path-traversal fix (`8de5331`), was containerized and got CI (`ba1e6f6`, `08556d6`), and
gained quota-fallback resilience for the AI model calls (`8178b2c`). Someone reviewing this
project six months from now — or an interviewer deciding whether to trust this project's
process — doesn't have to take anyone's word for how it evolved; they can read the actual
sequence of real decisions directly out of the commit history itself.

### What makes a good commit message, in this project's own style

Notice what these messages are *not*: they're not "fix bug," "update code," or "wip." Each
one says specifically what changed (`"Fix escalation-prompt hang on closed stdin and a wrong
decline message"`) and, often, folds in a hint of *why* or *what it enables*
(`"Add Gemini daily-quota fallback across models, fix assisted-recovery ignoring
GEMINI_MODEL"` tells you both the feature added and a real bug fixed alongside it). That
matters more here than in a typical project, because this project was "reviewed and
adversarially tested repeatedly over time" (per its own commit history — see `5dea14a`,
`246b87d`) — a future reader trying to understand *why* something is built the way it is can
often find the answer by reading the commit message that introduced it, rather than having
to reverse-engineer intent from code alone.

### "What happens if...?"

| Situation | What happens |
|---|---|
| You want to see exactly what changed in the commit that added authentication | `git show 8de5331` shows the exact lines added/removed in that commit, with the message explaining what and why. |
| You accidentally committed something you shouldn't have (like a real API key) | If it's still on your machine and not pushed, you can fix it before sharing; once pushed to a public GitHub repo, treat the leaked secret as compromised and rotate it — Git's permanent history is exactly why prevention (`.gitignore`, never hard-coding secrets) matters more than cleanup after the fact. |
| Two people want to work on two different features at the same time without one accidentally undoing the other's work-in-progress | This is exactly the problem branches solve — but this project has one contributor, so that specific problem never comes up here. |
| You want to know whether the "path-traversal fix" mentioned in `SECURITY.md` was a real, separate piece of work or just a passing mention | `git log` shows a real commit for it — `8de5331`, "Add real authentication and fix a path-traversal bug in the capability API" — so the claim is checkable against real history, not just asserted in prose. |
| `node_modules/` or `.env` almost got committed by accident | `.gitignore` stops it before it happens — see below. |
| Someone asks "why isn't this using feature branches and pull requests like a real team would?" | Because this is a small, single-contributor take-home project, where the coordination problem branches solve (multiple people needing to work in parallel without stepping on each other) doesn't exist — see "Why one branch" below. |

---

## Part 2 — For engineers: why, what, how, where

### Why

Git exists to answer two questions reliably, at any point in a project's life: *what did
this look like at some earlier point*, and *why did it change*. For a project like this
one — built incrementally, reviewed adversarially, and hardened in distinct, separable
passes (core system → stretch goals → adversarial review fixes → auth/containers/CI →
resilience) — the second question matters as much as the first. A reviewer (or a future
maintainer) shouldn't have to guess why the path-traversal fix exists; `git log` and
`git show 8de5331` answer that directly, in the author's own words, at the moment it
happened.

### What

- **Repository**: the full project at `/Users/devpatel/Desktop/interface.ai`, tracked by
  Git from `450cf63` ("Computer-use automation system: discovery agent, capability
  artifacts, deterministic replay") onward.
- **Commits**: each one a complete, checkpointed snapshot of every tracked file's contents
  at that point, plus a message. `git log --oneline` (as run above) shows the abbreviated
  hash and first line of each commit's message, newest first.
- **Branch**: `main`, the single branch this entire history lives on (confirmed by
  `git status` reporting `On branch main` and the CI workflow's own triggers being scoped to
  `branches: [main]` for both `push` and `pull_request`).
- **`.gitignore`** (repo root):

```
node_modules/
.tools/
dist/
*.log
.env
.env.local
.claude/
Assignment A — Computer-Use Automation System.pdf
```

### How

**Why `.gitignore` excludes what it excludes** — each line answers a specific "should this
really live in permanent, shared history" question:

- **`.env` / `.env.local`** — the file that holds real secrets (`GEMINI_API_KEY`,
  `CAPABILITY_API_KEY`, `DASHBOARD_PASSWORD`). Git's history is permanent and, once pushed,
  effectively public on GitHub — a secret committed even once and later "removed" is still
  sitting in an earlier commit, retrievable by anyone with access to the history. The right
  fix is never letting it in in the first place, which is exactly what this line does; see
  [`19-security-and-authentication.md`](19-security-and-authentication.md) for the full
  secrets story.
- **`node_modules/`** — every dependency this project downloads via `npm install`, fully
  reproducible from `package.json` + `package-lock.json` on any machine at any time.
  Committing it would balloon the repository's size with a giant folder that's not
  hand-written and doesn't need a "history" of its own — `npm ci` regenerates it exactly,
  every time, from files that *are* tracked.
- **`dist/`** — the compiled JavaScript output of running `tsc` against this project's real
  TypeScript source. Same reasoning as `node_modules/`: fully reproducible from tracked
  source, not something that needs its own history.
- **`.tools/`, `*.log`** — local tooling state and log output, neither of which is source
  code or configuration meant to be shared.
- **`.claude/`** — local assistant configuration/state, not part of the project's shipped
  code or documentation.
- **`Assignment A — Computer-Use Automation System.pdf`** — the take-home brief itself,
  excluded rather than redistributed as part of the submission's own history.

**Why a single branch (`main`)**, precisely: branches exist to let independent lines of work
proceed without interfering with each other, and to gate merging behind review. Both of
those problems are about *coordinating multiple people* (or multiple truly independent,
long-running efforts by one person) working at the same time. This is a single-contributor
take-home project where work happened in a real, mostly linear sequence of passes (core
system, then stretch goals, then adversarial-review fixes, then production-hardening) — the
overhead of creating a branch per feature, opening a pull request against yourself, and
merging it back would add process without solving a coordination problem that doesn't
exist here. This is the same "simpler is fine, if it's genuinely justified by the project's
actual size" reasoning applied elsewhere in this codebase (a single Node process instead of
queues/services/a database — see
[`01-system-design.md`](01-system-design.md); one CI job instead of a deploy pipeline and a
platform matrix — see [`23-continuous-integration.md`](23-continuous-integration.md)).

### Worked technical example

```bash
git -C /Users/devpatel/Desktop/interface.ai log --oneline | head -5
```

```
3970c80 registry.json
9616255 Add mid-artifact resume for replay hard failures, fix a resume/abort ambiguity on closed stdin
33906b6 Fix escalation-prompt hang on closed stdin and a wrong decline message; add demo runbook
8178b2c Add Gemini daily-quota fallback across models, fix assisted-recovery ignoring GEMINI_MODEL
08556d6 Document the production-hardening pass: auth, containers, CI, architecture
```

```bash
git -C /Users/devpatel/Desktop/interface.ai show --stat 8de5331
```

would show exactly which files the authentication-and-path-traversal-fix commit touched
(e.g. `src/http/api-key-auth.ts`, `src/api/tenant-resolution.ts`, `SECURITY.md`) alongside
its full message, rather than requiring anyone to trust a prose description of that change.

### Edge cases & failure modes

- **A secret is committed by mistake before anyone notices** — `.gitignore` prevents `.env`
  itself from being staged normally, but doesn't retroactively protect a secret that was
  hard-coded directly into a tracked source file and already pushed; the only real fix at
  that point is rotating the secret, not just deleting the line in a new commit (the old
  commit still has it).
- **`node_modules/` or `dist/` accidentally getting committed anyway** (e.g. via `git add
  -A` before `.gitignore` existed, or a force-add) — bloats the repo permanently unless
  explicitly purged from history, which is exactly why the ignore rule exists ahead of time
  rather than as a cleanup step.
- **Someone expects a pull-request-based review workflow** — this repo's real history shows
  direct commits to `main`, consistent with a single-contributor project; there's no
  branch-protection/required-review process layered on top here, and none is claimed.
  Reviewer feedback for this project happened via structured adversarial review passes
  reflected as their own commits (e.g. `5dea14a`, `246b87d`), not via GitHub pull-request
  review threads.
- **A commit message that doesn't explain "why"** — this repo's own history mostly avoids
  this, but it's worth naming as the actual failure mode good commit messages guard
  against: a message like `"fix bug"` gives a future reader nothing to work with, versus
  `"Fix a real regression the clean-clone check caught: unattended replay was silently
  blocked"` (a real message in this history, `d59bedf`), which tells you what broke, how it
  was found, and what the fix addresses.

## Related docs

- [`02-glossary.md`](02-glossary.md) — the short definitions of Git/GitHub/branch/commit this file expands on
- [`19-security-and-authentication.md`](19-security-and-authentication.md) — why `.env` in particular must never reach Git history
- [`23-continuous-integration.md`](23-continuous-integration.md) — what runs automatically on every push to the one branch this history lives on
- [`01-system-design.md`](01-system-design.md) — the same "simpler is fine if justified" reasoning applied to the system's architecture
- [`../README.md`](../README.md) — the project index and setup instructions
- [`../REPORT.md`](../REPORT.md) — the original design write-up, itself a product of this project's real, checkable history
