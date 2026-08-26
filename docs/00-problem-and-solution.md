# The Problem, and What We Built

## In one sentence

Banks run a lot of old software that has no way for a computer program to talk to it
directly, so this project builds an AI "operator" that learns to use that old software by
looking at the screen and clicking around like a person would — and then, once it has
learned a task, it can repeat that task forever without needing the AI to think about it
again.

---

## Part 1 — For everyone: what problem is this solving?

### The world this lives in

Picture a credit union. Its members walk in, call, or chat online to do everyday banking
things: "look up my account," "open a savings account for my kid," "check why my last
transfer failed." Behind the counter, the credit union's staff use internal software to
actually do these things — pull up a member's record, fill in a form, click submit.

Some of that internal software is old. Not "a few years old" — often **decades** old. It was
built before today's web and cloud tools existed, and rebuilding it is expensive, risky, and
usually not worth it just to add "let a computer program call this directly." So the software
just keeps running, and the only way to operate it is the way a human always has: look at the
screen, find the right button, click it, type into the right box, read the result.

Companies like interface.ai build AI assistants that talk to a bank's customers. Those
assistants are smart — they can understand "I want to open a savings account" — but
understanding what to do is only half the job. Something still has to actually *do* it inside
that old software. That "something" is what this project is.

### Why not just "use an API"?

If the old software exposed an API (a well-defined, programmatic way for one program to ask
another program to do something), you'd just use that — it's simpler, faster, and safer. That
is always the first choice, and it's explicitly out of scope for this project because it's the
easy case. This project exists **specifically** for the hard case: software with *no* API at
all, where the only "interface" is the same screen a human employee looks at.

### The three things that make this genuinely hard

1. **The software behaves like it's from 2003** — because a lot of it is. No modern
   conventions, no helpful labels for automation to grab onto, sometimes literally laid out
   with `<table>` tags and no CSS. A person can still read it fine; a naive script chokes on
   it immediately.
2. **Things go wrong in normal, everyday ways.** A member ID doesn't exist. A staff member
   isn't allowed to see a particular account. A session times out because someone stepped
   away for coffee. A page is just slow one day. All of this is **normal life**, not a bug —
   and any automation that falls over the first time one of these happens is useless in
   practice.
3. **The same problem repeats hundreds of times.** A credit union isn't the only customer —
   there are hundreds of banks and credit unions, and many of them run the *same* underlying
   software product, just configured and rebranded slightly differently (different logo,
   different button text, sometimes a different layout). Building a one-off automation for
   every single one of them, from scratch, doesn't scale.

### What we built, in plain language

Think of it like training a new employee, once, and then giving every future employee a
laminated instruction card:

1. **Someone (an AI) sits down and actually does the task for the first time**, the slow,
   careful way — reading the screen, deciding what to click, typing the right thing, checking
   it worked. This is the "training" phase. We call it **discovery**.
2. **While they do it, we write down exactly what they did**, as a precise, structured
   recipe — not a vague summary, but "click the button labeled exactly this, then type into
   the box labeled exactly that." We call this recipe an **artifact** (think: a laminated
   instruction card that's specific enough for someone to follow without having to think).
3. **From then on, nobody needs the AI to "think" about this task again.** The recipe gets
   followed step by step, mechanically, by a much simpler, faster, cheaper program. We call
   following the recipe a **replay**.
4. **The recipe knows about the normal things that can go wrong** — "if you see this message,
   that means the account doesn't exist, that's a normal answer, not an error" — so it doesn't
   panic or lie about what happened.
5. **When something happens that the recipe genuinely doesn't know how to handle**, it stops
   and calls a human over — without losing its place. The human looks at the *exact same
   screen* the automation was looking at, fixes whatever needs fixing, and hands control back.
6. **The whole time, there are guardrails**: a list of what the automation is and isn't
   allowed to do, and extra caution around anything that can't be undone (like actually
   opening an account, versus just looking something up).

### A concrete walkthrough

Say the task is: *"Look up member 10001 and open a new Savings account for them with a $100
deposit."*

- **First time (discovery):** An AI is given that goal and a starting web page. It looks at
  the page, sees a "Sign On" screen, decides to type the operator ID and password, clicks
  "Sign On," sees a member search box, types "10001," clicks "Look Up Member," sees the
  member's page, clicks "Open New Sub-Account," picks "Savings" from a dropdown, types "100"
  into the deposit box, and clicks "Submit." Because actually opening an account is a
  real, hard-to-undo action, the system pauses right before that click and asks a human,
  "this is about to actually happen, are you sure?" — the human says yes, and it proceeds. It
  lands on a confirmation page showing a new account number. Success — and the *whole
  sequence* just performed gets written down as a reusable recipe.
- **Every time after that (replay):** Given a *different* member ID and deposit amount, the
  system follows the exact same recipe — sign on, search, open account, submit — using the
  new numbers, without any AI "thinking" involved. It's fast, cheap, and does the same thing
  every time, the way a vending machine does the same thing every time you press the same
  button.

### "What happens if...?" — a few real scenarios

| Situation | What happens |
|---|---|
| The member ID doesn't exist | The system recognizes the "no such member" message on screen and reports back *"no such member"* as a normal, useful answer — not a crash, not a scary error. |
| The staff member isn't allowed to access this particular member's account | Same idea — recognized as a normal "permission denied" outcome, reported clearly. |
| The internal software session times out mid-task (e.g. a real timeout, unrelated to anything the automation did) | The system notices, signs back in automatically, and picks up exactly where it left off — no human needed for this one, because it's a well-understood, recoverable situation. |
| The screen shows something *nobody* anticipated — a brand-new error, a weird page, a button that doesn't do what it used to | The system stops, takes a screenshot, and says "I'm stuck here, and here's exactly why" — instead of guessing, clicking randomly, or pretending it worked. |
| A human needs to step in and fix something by hand | They take over the *same* browser window the automation was using (not a fresh one, not a description of the problem to interpret) — do whatever manual thing needs doing — and hand control back. The automation picks up from there, on the same page, the same session. |
| The task is about to do something that can't be undone (actually opening an account, actually moving money) | The system pauses and requires explicit confirmation before proceeding — every time, unless a human has separately reviewed and pre-approved this exact recipe for unattended use. |
| The same bank's software, but a *different* bank (a different customer) that happens to run the same underlying product, just rebranded | Instead of training a brand-new AI from scratch, the *same* recipe is reused, with a small, reviewed list of "here's what's different for this bank" (e.g., their button says "Log In" instead of "Sign On") layered on top. |

---

## Part 2 — For engineers: the problem statement and solution, precisely

### Why (the problem, precisely)

This is a submission for interface.ai's take-home brief, "Computer-Use Automation System."
interface.ai builds AI agents for banks and credit unions. Those agents need to *act* inside
back-office software that, for a large and important long tail of cases, exposes no API — the
only integration surface is the UI itself (legacy web apps, server-rendered HTML, framesets,
non-semantic markup, sometimes native desktop apps). The brief asks for a system that:

1. Uses an LLM ("computer use") to accomplish a goal against a live UI the first time —
   observing state, deciding an action, acting, and repeating until done or stuck.
2. Records that successful run as a **typed, versioned, reusable artifact** — a contract, not
   a transcript — decoupled from the raw model conversation.
3. **Replays** that artifact deterministically, with *zero* model calls, using stable
   element-targeting and returning a structured result.
4. Distinguishes, in that result, between three fundamentally different things: a legitimate
   business answer ("no such member"), a recoverable runtime hiccup (a session timeout), and a
   genuine, undebuggable failure.
5. **Escalates to a human** when it can't proceed safely — handing over the *live session*,
   not a description of the problem — and can resume afterward.
6. Enforces **safety guardrails**: an explicit allowlist of permitted actions, conservative
   handling of irreversible ("risky") actions, and no persistence of secrets or raw sensitive
   data.
7. Has a credible design story for two forms of scale the brief explicitly says *not* to
   over-build for: heterogeneous surfaces (legacy web, desktop) and multi-tenant reuse
   (hundreds of institutions, many running the same underlying vendor product).

### What (the solution, precisely)

A single Node.js/TypeScript process (deliberately no queues, no services, no database — see
"why simplicity" below) built around five core abstractions, each with one clear
responsibility:

| Abstraction | Answers | Lives in |
|---|---|---|
| **Surface** | How do we perceive and act on *any* UI, without assuming a clean DOM? | `src/surface/` |
| **Discovery agent** | How does an LLM turn a goal into a sequence of real actions against a live Surface? | `src/agent/` |
| **Artifact** | What's the reusable, typed contract a finished discovery run becomes? | `src/artifact/` |
| **Replay engine** | How do we execute that contract deterministically, and classify what happens? | `src/replay/` |
| **Guardrails** | What is *ever* allowed to happen, and how conservatively do we treat risky actions? | `src/guardrails/` |
| **Escalation** | How does a human take over the *same* live session, and hand it back? | `src/escalation/` |
| **Evidence** | How do we prove any of this actually happened, and keep it safe to look at? | `src/evidence/` |

On top of that core, five of the brief's six optional "stretch goals" were built for real
(confidence & approval, cross-tenant reuse, an agent-facing HTTP capability interface,
bounded assisted/vision-grounded LLM recovery, and multi-run stability), plus two things that
aren't stretch goals at all but round out a genuinely operable system: a read-only ops
dashboard, and a compliance/audit export for a bank's audit function. A full write-up of every
decision and trade-off lives in [`REPORT.md`](../REPORT.md) at the repo root — this `docs/`
folder is the expanded, feature-by-feature version of that same story.

### How (the shape of the solution)

The through-line, in the brief's own words, is: **the model discovers, the artifact becomes a
reusable capability, and deterministic replay is how an AI agent invokes it in production.**
Concretely: discovery and replay share the *exact same* guardrail-checking and
element-targeting code paths (`GuardrailsPolicy`, `Surface.perform`/`predictNavigation`) — so
an artifact is a faithful contract, not a second implementation of "how to click things," and
an agent calling the production capability API can never get looser guardrails than a human
running the CLI. See [`01-system-design.md`](01-system-design.md) for the full module map and
data flow, and each other file in this folder for one feature at a time, in depth.

### Where (this fits in the real product)

Framed the way the brief itself frames it: *the agent-facing product decides what to do; this
system is how it reliably and safely does it.* interface.ai's own products sit on the "decide
what to do" side; this project is a small, real version of the "how it reliably and safely
does it" side — the layer that would sit underneath, e.g., an "Integration Manager" connecting
to dozens of different core banking systems across hundreds of institutions.

## Related docs

- [`01-system-design.md`](01-system-design.md) — the architecture and module map in full
- [`02-glossary.md`](02-glossary.md) — every term used across this documentation, defined once
- [`README.md`](README.md) — index of every doc in this folder
