# The Extended Console: One Page, Every Target, and Onboarding a New One

## In one sentence

Beyond what either brief requires: one chat-ui process serves every target through a
runtime-switchable sidebar instead of one process per target, a genuine mid-replay escalation
can now be resolved from that same page instead of only a terminal, and a "register a new
target" form proves the discovery agent generalizes to a UI it has never seen — verified
against an independently-built fixture app, not a relabeled copy of an existing target.

**Scope note, read this first:** nothing in this document is required by the take-home brief
or the MERIDIAN adaptation brief. It exists because building it answered real questions
worth asking, not because a rubric asked for it. `REPORT.md`'s own seven required headings
(plus its stretch-goals section) are the graded core; this document is intentionally kept
separate so it doesn't crowd that story. See `REPORT.md` §9 for the short version.

---

## Part 1 — For everyone: what this actually adds

### The problem this solves

Earlier in this project, watching the system work against two targets (the local mock-bank
app and the live MERIDIAN CORE site) meant running two separate chat processes on two
separate ports, remembering which port was which, and retyping long environment-variable
commands to switch between a MERIDIAN teller and a MERIDIAN supervisor. None of that changed
what the system could *do* — it only made it slower and more error-prone to *show*.

Separately, one real question kept coming up while demoing: "when a genuinely new bank shows
up, where's the button for that?" Before this work, the honest answer was "there isn't one —
you edit a JSON file and run a CLI command." That's a legitimate, deliberate design choice
(explained below), but it wasn't something you could point at and click.

### A concrete walkthrough

Open `http://localhost:4800`. The sidebar has a target switcher at the top — Mock Bank,
MERIDIAN CORE (teller), MERIDIAN CORE (supervisor) — and clicking one instantly swaps the
capability catalog, the demo-script buttons, and which backend identity your messages use,
all without restarting anything. Ask the teller target to place a hold on a share it doesn't
have permission for, and it comes back `supervisor_override_required`; switch to the
supervisor target and ask the exact same question, and it actually posts. Same backend, same
catalog — only the signed-on identity changed. That's the proof the switch is real, not
cosmetic.

If a request hits something the system genuinely can't resolve on its own — an unexpected
dialog, a stuck state — a red card appears above the chat log with a live screenshot of the
exact moment it paused, a plain-language reason, and Resume/Abort buttons. The real browser
window this system is driving is visible on the same machine (headed by default), so a
person can look at both at once: the actual page, and the console's own summary of why it
stopped.

Further down, a collapsed "Register a new target" section takes a URL, a short list of
routes, and a goal, and does two real things when submitted: it adds that URL to the
system's permitted-destinations list, and it drives a real, LLM-powered attempt at the goal
against that brand-new page. It does **not** hand back a finished, reusable capability — that
last step (teaching the system exactly which fields mean what, and which error messages mean
what) still needs a person to review the attempt and write that down, the same way it always
has for every capability this system already knows.

---

## Part 2 — For engineers: why, what, how, where

### Why

Three separate, real gaps, found by using the system rather than by inspection:

1. **Multiple chat-ui processes for multiple targets** was pure operational overhead —
   nothing about the underlying architecture required it. Each process already held
   everything needed (a capability catalog, a planner, a chat endpoint); the only thing
   missing was a way to pick which backend a given browser session was talking to.
2. **The capability API's `/invoke` route had no operator to hand a stuck run to.** By
   design, an unattended HTTP caller declines a risky/stuck step outright rather than
   hanging on a prompt with no terminal attached — correct, but it meant the console (the
   thing people actually watch during a demo) could never show the human-escalation story
   that the CLI already proves is real.
3. **"How do you onboard a new target?" had a true but entirely manual answer** — edit
   `config/allowlist.json`, write a capability config JSON, run a CLI script. Real, and
   arguably the *right* level of automation (see "What this doesn't do" below) — but with no
   way to demonstrate it without a terminal and a text editor.

### What

- **`TARGETS` registry** (`src/chat-ui/server.ts`) — an array of `{ id, label, apiBase,
  fillParams, demoScriptsFile, dashboardUrl }`. A per-session `activeTargetId`
  (`req.session`, the same mechanism already holding `pendingPlan`/`pendingChain`) selects
  which entry every other route (`/chat`, `/catalog`, `/config`) resolves against. Switching
  clears any pending confirmation/chain/history for that session, since a different target
  means a different capability catalog and a different signed-on identity underneath —
  anything pending against the old one is actively wrong against the new one, not merely
  stale.
- **`HttpEscalationRegistry`** (`src/api/http-escalation.ts`) — a small in-memory class the
  capability API's `/invoke` route wires into `replay()`'s `onEscalate` callback in place of
  auto-declining. A genuine hard failure now pauses on a real `Promise`, exposed as `GET
  /interventions` (list pending, each with a screenshot the registry itself captured) and
  `POST /interventions/:id/resolve` (`resume`/`abort`, settling that `Promise` and letting the
  original blocked `/invoke` request finally complete). Proxied through chat-ui at the same
  two paths, polled by the browser every 2.5s. Deliberately a *second*, HTTP-native
  implementation, not a replacement for `EscalationController`'s terminal-prompt version
  (`src/escalation/controller.ts`, see `08-escalation-and-handoff.md`) — the two exist
  because a browser tab and a terminal are different kinds of "someone is watching."
- **`POST /register-target`** (`src/chat-ui/server.ts`) — parses a newline-delimited routes
  textarea (`METHOD /pattern [safe|risky]`) into real `RouteRule`s, merges any genuinely new
  ones (and the base URL) into `config/allowlist.json` **on disk**, then launches a real
  `DiscoveryAgent` run against the given goal/start URL using a freshly-constructed
  `GuardrailsPolicy` (which re-reads the just-written file — `loadAllowlist()` has no cache,
  so this works within the same request). Returns the raw `DiscoveryResult` — status, steps
  taken, extracted outputs, evidence path. It does not call `buildArtifact()`: turning a
  successful run into a typed capability still needs `paramMappings`/`successCheckpoint`/
  `knownOutcomes`, and this repo has been consistent throughout that those are authored by a
  human reviewing real evidence, not inferred (`recorder.ts`'s own doc comment; `REPORT.md`
  §7's "human-authored, not auto-mined" cut applies here without modification).
- **`apps/utility-mock/`** — a small, standalone Express + EJS app (GridPoint Utility
  Co-op), built specifically to make the generalization test honest. Different domain
  (utility billing, not banking), different field names (`agentId`/`pin`, not
  `username`/`password`), different routes, different terminology, its own seed data and
  business outcomes (an account-not-found search, a suspended account whose writes are
  blocked, a meter reading rejected for being lower than the one on file). Reusing
  mock-bank's own code on a different port — which an earlier pass did, to prove the
  allowlist-registration mechanism — would **not** have proven the discovery agent
  generalizes to unfamiliar structure, since it would have been the same markup the agent
  had already seen. This fixture exists so that claim has real, independent evidence instead
  of an assertion.

### How (the discovery agent perceives GridPoint the same way it perceives everything else)

Nothing about `DiscoveryAgent` or `Surface.observe()` knows GridPoint exists. Discovery
against it goes through the exact same loop as every other target: `observe()` walks the
live DOM for interactive elements and their accessible names (`Surface.observe` /
`dom-scan.ts`), the model receives a flattened role+name list and picks one function call per
turn from the same generic tool vocabulary (`navigate`/`click`/`type`/`select_option`/
`extract`/`finish`/`escalate`), and every action still goes through
`GuardrailsPolicy.authorize()` before it executes. The only GridPoint-specific things in the
whole system are the two lines of goal text describing what to do and the allowlist entries
`POST /register-target` added — which is exactly the point being demonstrated.

### Where

- `src/chat-ui/server.ts` — `TARGETS`, `resolveTarget`, the `/target`, `/interventions`
  (proxy), and `/register-target` routes.
- `src/chat-ui/public/` — the sidebar's target switcher, intervention card, and
  "Register a new target" form (`index.html`, `chat.js`, `style.css`).
- `src/api/http-escalation.ts` — `HttpEscalationRegistry`, wired into `src/api/server.ts`'s
  `/invoke` handler.
- `apps/utility-mock/` — the independent fixture app (`src/server.ts`, `src/data.ts`,
  `views/*.ejs`). `npm run utility-mock` (port `4300` by default).
- `config/demo-scripts/*.json` — per-target canned chat messages, one file per `TARGETS`
  entry, covering every naturally-reachable known outcome for that target's capabilities
  (not just a happy-path sample — see each capability's own `knownOutcomes` in
  `evidence/artifacts*/*.artifact.json` for the full set each file works through).

### Edge cases & what this deliberately doesn't do

- **Risky actions and stuck-run escalations during `/register-target` discovery are
  auto-declined/auto-aborted, not routed to the intervention card.** `HttpEscalationRegistry`
  is bound to a *replay's* `onEscalate` contract (`{ step: ArtifactStep, stepNum, reason }`)
  — keyed on an artifact step that doesn't exist yet during discovery. Reusing it here would
  mean bolting a second, subtly different contract onto a registry designed for the first
  one, under time pressure, for a feature neither brief requires. A read-only reconnaissance
  goal (sign on, look something up) never reaches this path at all; a goal needing
  confirmation or recovery should go through `run-agent`/`--interactive-escalation`, which
  already has a real answer for both (`08-escalation-and-handoff.md`).
- **The allowlist route-pattern matcher was not changed to support wildcards.** A tempting
  shortcut for "register any new URL" would be a catch-all pattern (`/*`) matching every
  route on a new origin at once. That was deliberately rejected: `config/allowlist.json`'s
  whole safety property is that every specific route is explicitly declared, and weakening
  that matcher — security-critical code every other target also depends on — to make one new
  convenience feature easier was the wrong trade, especially this close to a live demo. The
  form instead asks for explicit routes, the same information a human editing the file by
  hand would need to know anyway.
- **An escalation raised by one target is only visible while that target is selected.** Each
  target's capability-api instance holds its own `HttpEscalationRegistry` in its own
  process's memory; chat-ui's `/interventions` proxy only asks the *currently active*
  target's instance. Switching away from a target with a pending escalation doesn't lose the
  paused run (it's still genuinely blocked, waiting), but you won't see its card again until
  you switch back.
- **Nothing here survives a process restart.** Both `HttpEscalationRegistry` and the
  discovery-run tracking behind `/register-target` are in-memory only — consistent with this
  project's "don't build scaling infrastructure you don't need" posture (brief §9) for what
  is fundamentally demo/onboarding tooling, not a production incident-management system.

## Related docs

- [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md) — the terminal-prompt
  escalation path this extends into the console, not replaces.
- [`03-surface-abstraction.md`](03-surface-abstraction.md) — why nothing about
  `Surface.observe()`/`perform()` is specific to any one target, which is what makes GridPoint
  a meaningful test rather than a formality.
- [`25-mock-bank-target-app.md`](25-mock-bank-target-app.md) — the original target fixture,
  for comparison against `apps/utility-mock/`'s deliberately different shape.
- [`15-conversational-frontend.md`](15-conversational-frontend.md) — the chat/console layer
  this document's `TARGETS` registry sits on top of.
