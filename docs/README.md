# Documentation Index

This folder is the full, feature-by-feature documentation of the Computer-Use Automation
System — the expanded version of the story [`../REPORT.md`](../REPORT.md) tells at a glance.
**Every file follows the same structure**: a plain-language explanation with a real-world
analogy and worked example for non-technical readers, followed by a precise technical
why/what/how/where for engineers, using this project's real commands, real file paths, and
real example data throughout — nothing invented.

If you're new here, read in this order:

## Start here

1. [`00-problem-and-solution.md`](00-problem-and-solution.md) — what problem this solves, and
   what we built, in plain language first
2. [`01-system-design.md`](01-system-design.md) — how all the pieces fit together
3. [`02-glossary.md`](02-glossary.md) — every term used across this documentation, defined
   once (including basics like Git, Docker, npm, and TypeScript for non-technical readers)

## The core loop: how a task is learned once, then run forever

4. [`03-surface-abstraction.md`](03-surface-abstraction.md) — how the system perceives and
   acts on a UI, without assuming a clean, modern web page
5. [`04-discovery-agent.md`](04-discovery-agent.md) — the AI-driven loop that learns a task
   for the first time
6. [`05-artifact-schema.md`](05-artifact-schema.md) — the reusable "recipe card" a successful
   discovery run becomes
7. [`06-deterministic-replay.md`](06-deterministic-replay.md) — running that recipe again,
   with no AI involved, and the three-way result contract (success / business outcome /
   failure)

## Safety and human oversight

8. [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the allowlist, risk
   classification, and redaction
9. [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — how a human takes over the
   *same* live session when the system gets stuck, for both learning and replaying a task
10. [`09-evidence-and-logging.md`](09-evidence-and-logging.md) — the black-box recorder behind
    every run

## Trust, drift, and reuse across many institutions

11. [`10-confidence-and-approval.md`](10-confidence-and-approval.md) — scoring how reliable a
    recipe has proven itself, and gating unattended use on that score
12. [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md) — reusing one recipe across
    different, similarly-configured institutions
13. [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — noticing early when the
    underlying software has changed slightly
14. [`17-multi-run-stability.md`](17-multi-run-stability.md) — "is this healthy right now,"
    distinct from "has this generally worked over its whole life"

## Letting an AI agent — and a person in plain English — actually use this

15. [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md) — one bounded
    AI-assisted recovery attempt when replay hits an unrecognized snag, including a
    vision-based fallback for surfaces with no clean structure at all
16. [`14-capability-api.md`](14-capability-api.md) — the HTTP surface an AI agent calls to
    discover and invoke a capability by name
17. [`15-conversational-frontend.md`](15-conversational-frontend.md) — turning a plain-English
    request into a specific, typed capability call

## Operating this in the real world

18. [`16-dashboard.md`](16-dashboard.md) — one screen showing everything about every
    capability, instead of four separate commands
19. [`18-compliance-audit-export.md`](18-compliance-audit-export.md) — turning run history
    into a report a bank's audit function can actually use
20. [`19-security-and-authentication.md`](19-security-and-authentication.md) — the
    consolidated threat model: secrets, authentication, and what's deliberately not built yet
21. [`20-gemini-quota-and-resilience.md`](20-gemini-quota-and-resilience.md) — riding out AI
    provider hiccups, and falling back across models when a daily quota runs out

## The tools and practices behind the project itself

22. [`21-testing-strategy.md`](21-testing-strategy.md) — what's automatically tested, what's
    verified with real evidence instead, and why
23. [`22-docker-and-containers.md`](22-docker-and-containers.md) — what Docker is, and what
    this project does (and deliberately doesn't) package into containers
24. [`23-continuous-integration.md`](23-continuous-integration.md) — the automatic check that
    runs on every change before it's trusted
25. [`24-git-and-version-control.md`](24-git-and-version-control.md) — what Git and GitHub
    are, and how this project actually uses them
26. [`25-mock-bank-target-app.md`](25-mock-bank-target-app.md) — the deliberately old-fashioned
    fake bank app this whole system practices against, and why every seeded scenario exists

## Also see, at the repo root

- [`../README.md`](../README.md) — setup instructions and the exact commands to run a live
  demo end to end
- [`../REPORT.md`](../REPORT.md) — the original ~3-page design write-up (architecture,
  artifact schema, determinism & error handling, heterogeneity/multi-tenant, escalation,
  safety, and what was cut and why) — this `docs/` folder is the long-form expansion of it
- [`../SECURITY.md`](../SECURITY.md) — the source-of-truth threat model
  ([`19-security-and-authentication.md`](19-security-and-authentication.md) is its
  long-form, plain-language companion)
- [`../RUNBOOK.md`](../RUNBOOK.md) — the live-demo rehearsal script
