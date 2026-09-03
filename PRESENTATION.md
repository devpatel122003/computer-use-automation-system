# Presentation Prep: One-on-One With Leadership

*This is the doc to talk from, not read from. `REPORT.md` is the written design doc;
`RUNBOOK.md` is the click-by-click demo script if you show it live; `docs/` is where every
claim below has its full depth and evidence. This doc is the narrative — what to say, in what
order, and how to answer when they push back.*

---

## 1. The 60-second pitch (say this first, then stop and let them react)

"Our AI agents decide *what* to do for a bank customer. The hard part is *doing* it — most
core banking software has no API, only a screen a human operator uses. This project is that
missing layer: an LLM drives the actual UI once to learn a task, we record what it did as a
typed, reusable **capability**, and after that, the task runs **deterministically** — no
model, no re-reasoning, just click-type-check — every time it's invoked. When it hits
something it genuinely can't handle safely, it stops and hands control to a real human on the
same live session, not a fresh one.

I then took that same core and pointed it at a real, live legacy target you gave me — MERIDIAN
CORE — and wrapped it in an API, a chatbot, and a dashboard so it's demoable end to end, not
just runnable from a terminal."

That's the whole thing. Everything else is defending the decisions inside it.

---

## 2. What you built — walk through one real example out loud

Don't describe the architecture in the abstract first — walk through one concrete run. It's
easier to follow and it's what actually happened.

**"Let me show you how 'check a member's balance' became a capability."**

1. I gave an LLM (Gemini) the goal in plain English and pointed it at the login page. It
   looked at the page — not the raw HTML, a flattened list of what a screen reader would see:
   roles and names — decided to type into the operator ID field, typed, decided to click Sign
   On, clicked, and so on. One decision, one action, per turn. No test IDs anywhere in this
   app, on purpose — that's the whole point, most legacy bank software doesn't have them.
2. When it reached the member's page and read the balance, it called `finish`. That successful
   run got turned into an **artifact** — not a recording of exactly what happened, but a
   *contract*: here are the steps, here's how to find each button (with three fallback ways to
   find it, ranked by how likely they are to still work next month), here are the inputs you
   can vary (`memberId`), here's what you get back (`checkingBalance`, `savingsBalance`), and
   here's the full list of things that can legitimately happen instead of success — "no such
   member," "you don't have permission," "the session timed out."
3. From then on, nobody needs the LLM again for this task. **Replay** re-runs those exact
   steps against new inputs, with zero model calls — just resolve the locator, click, verify a
   checkpoint, move on. It's fast, cheap, and it behaves the same way every time.

Then say: "I did this for eleven capabilities total — five against a mock bank I built, six
against your real MERIDIAN CORE site."

---

## 3. The decisions worth defending (say the *why*, not just the *what*)

Pick 3–4 of these based on how technical the room is. Each line is phrased so you can say it
verbatim.

- **"Why not just hand-write Playwright scripts?"** — Because that's brittle by construction:
  one selector, and the day the markup changes, it breaks with no explanation. Every locator
  in my artifacts is an *ordered fallback chain* — try the most robust way to find something,
  fall back to the next, and log which one actually worked. That log is a real drift signal:
  I can tell you which steps are quietly relying on a weaker fallback before they break for
  real.

- **"Why record a contract instead of just a script?"** — Because an AI agent calling this in
  production needs to know what it's allowed to pass in and what it'll get back, without
  knowing anything about the UI underneath. Typed inputs, typed outputs, a success condition —
  that's a function signature, not a macro.

- **"Why does 'no such member' get special treatment?"** — Because conflating a legitimate
  business answer with a system failure is, in my read of this problem, the single most
  common mistake in automation like this. My replay result is a three-way split: `success`,
  `business_outcome` (a real, expected answer — not found, permission denied, insufficient
  funds), and `failure` (something genuinely unanticipated, with enough detail — which step,
  what I expected, what I actually saw, a screenshot — to debug it without re-running).

- **"Why does the browser run with a visible window instead of headless?"** — Because the
  escalation story only means something if it's real. When automation gets stuck, it doesn't
  hand off a description of the problem — it hands off *the actual browser window it was
  using*. A human can look at the same page, fix whatever needs fixing by hand, and hand
  control back. I made that literal on purpose: the window is genuinely visible on the same
  machine.

- **"Why is the allowlist so strict — every route spelled out?"** — Because this touches
  regulated financial data. I'd rather the agent refuse to act on something I didn't
  explicitly permit than guess. Every action, in discovery or replay, goes through the same
  one function that checks the real predicted destination — not "is this URL string similar
  to an allowed one," the *actual* method and path a form or link would hit.

- **"Why does an approved capability still sometimes ask for confirmation?"** — Because
  approval isn't permanent trust. I built a confidence score from real run history, and if an
  artifact's reliability drops — say, because the UI drifted or a run genuinely failed — it
  falls back to requiring a human to confirm risky actions again, automatically. I had to
  rebuild that confidence twice today after legitimate failures dropped it below the
  threshold — which is the system doing exactly what it's supposed to do, not a bug.

---

## 4. What's real, what's mocked, what's cut — say this before they ask

Leadership will respect this more than a claim of "everything's perfect." Have it ready,
unprompted, near the end of the walkthrough:

- **Real, not simulated:** the LLM discovery runs (against both mock-bank and your live
  MERIDIAN site), the deterministic replay engine, every business-outcome/failure
  classification, the guardrail allowlist, redaction (verified by grepping the entire evidence
  tree for plaintext credentials — found none), and the human-escalation handoff — both the
  terminal version and, as of today, a version reachable from a web console with a live
  screenshot and Resume/Abort buttons.
- **Deliberately mocked, and I can say exactly why:** the operator console *look* (a plain
  screenshot + two buttons, not a full co-browsing UI) — the brief scopes that out explicitly,
  and a fuller version is a described extension, not a gap I missed. The chatbot's customer
  identity (it doesn't know *which* member is talking) — out of scope for a demo, real payoff
  only in a real product. Docker containers are reviewed for correctness but not build-tested
  — I didn't have Docker available in the environment I built this in.
- **What I cut on purpose:** known error outcomes are hand-authored after watching one real
  discovery run, not auto-detected — because a single happy-path run can't observe its own
  error states, and I'd rather be honest about that than fake an inference step. Same for how
  a UI field maps to a named input — a small explicit table, not an LLM guessing.

---

## 5. If they want to see it live (2–3 minutes, not the full RUNBOOK)

Full script with timings and fallbacks: `RUNBOOK.md`. If you only have a few minutes in a
one-on-one, this is the tightest path that hits the highest-weighted criteria:

1. `npm run chat-ui` (assumes mock-bank + capability-api + capability-api-meridian are
   already running) → open `http://localhost:4800`.
2. Ask *"What's the balance for member 10001?"* — real success, real extracted data.
3. Ask *"What's the balance for member 99999?"* — a clean `permission_denied` business
   outcome, not a crash.
4. Switch the target to **MERIDIAN CORE (teller)**, ask to place a hold as a teller — comes
   back `supervisor_override_required`, a real 403 from their live site. Switch to
   **(supervisor)**, ask again — it actually posts. Same backend, only the identity changed.
5. If there's time for the escalation story: ask *"Open a savings account for member 77777
   with $50"*, confirm — a red card appears with a live screenshot; the real browser window is
   genuinely visible; click through the interstitial for real, click Resume; it completes.

---

## 6. Anticipated questions, and strong answers

**"How does this scale to hundreds of tenants running the same software?"**
Cross-tenant reuse is built, not just designed: the same recorded artifact runs against a
second, differently-branded tenant via a small named override — a handful of copy/locator
patches, not a re-recording. I also proved the override is load-bearing with a negative
control: the same artifact *without* the override genuinely fails on that tenant. Detecting
drift across a fleet is a described extension (per-tenant aggregation, a persistence layer) —
building that now would be exactly the "scaling infrastructure you don't need yet" the brief
warns against.

**"What if the LLM decides to click the wrong thing?"**
During discovery, every action — model-proposed or not — goes through the same guardrail
check as replay. A write action always requires explicit confirmation. During replay, the
model isn't involved at all; it's mechanically resolving the exact same locator chain that was
recorded and verifying a checkpoint before moving on.

**"Is the human escalation actually real, or just a demo?"**
It's a literal, live-tested proof, not a description: the human operates the *same*
Playwright browser session the automation was using, not a fresh one. I verified this
specifically — both that a real click in the real window gets correctly detected on resume,
and that a resume without a real fix correctly fails again rather than pretending to succeed.

**"What was the hardest part?"**
Two things, honestly. First, getting the failure taxonomy right — deciding what's a business
outcome vs. a recoverable condition vs. a hard failure isn't obvious until you see enough real
runtime behavior, and I found and fixed real cases where I had it wrong (a session timeout
that should self-heal, an already-closed account that was hard-failing instead of answering
cleanly). Second, adapting to your real MERIDIAN target surfaced a real timing bug my mock
target never would have — a Playwright/network race that only shows up against a genuinely
external, latency-bound site.

**"What would you build next with more time?"**
Three things, in order: a real per-tenant drift dashboard instead of a single-artifact report;
turning the hand-authored known-outcome list into something a human approves rather than
writes from scratch, by seeding it from a small library of common legacy-app error patterns;
and a real desktop-automation implementation of the `Surface` interface, since the
abstraction's already shaped to take one without touching anything above it.

**"Why should we trust this over an existing RPA tool?"**
Most RPA tools record a script and replay it literally — they don't distinguish "this failed
because the account doesn't exist" from "this failed because something broke," and they don't
have a first-class answer for "what happens when it gets stuck." Those two things — the
outcome taxonomy and the real human handoff — are the actual hard problems in this domain, and
they're the two things I spent the most time getting right, not the plumbing around them.

**"What's the one thing you're least sure about?"**
The known-outcome list is hand-authored from one clean run — it's honest, but it means a
genuinely novel failure mode I haven't seen yet will surface as a hard failure the first time,
not a smooth business outcome. That's a real limitation, not a hidden one — the system is
designed to fail loud and debuggable in that case rather than guess, which I think is the
right trade-off for financial data, but it is a trade-off.

---

## 7. Closing line

"The core system — discovery, artifact, replay, guardrails, evidence, escalation — is exactly
what both briefs asked for, and I can defend every line of it. I also went further than
either brief required, mostly to stress-test my own claim that this generalizes: a unified
console instead of per-target processes, and a 'point this at a brand-new UI' flow I verified
against an app I built specifically so it wasn't cheating. I'm happy to go as deep as you want
on any single piece of it."
