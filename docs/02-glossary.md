# Glossary

Every term used across this documentation, defined once here in plain language first, with a
more precise technical note where it matters. Terms are grouped by theme rather than strict
alphabetical order, so related concepts sit near each other.

---

## Domain terms (from the take-home brief)

**Computer use** — an AI model operating a computer the way a person would: looking at what's
on the screen and then clicking and typing, instead of calling a well-defined programming
interface. This project uses "computer use" once, during discovery, to figure out a task —
and never again after that, during replay.

**API (Application Programming Interface)** — a well-defined way for one piece of software to
ask another piece of software to do something, without needing to look at a screen. The gold
standard for integration when it's available; this whole project exists for the case where it
*isn't*.

**DOM (Document Object Model)** — the structured representation a web browser builds of a web
page: which elements exist, how they're nested, what their attributes are. A "clean" DOM has
meaningful, stable names for things; a legacy app's DOM often doesn't — it might just be rows
and columns of a big table with no indication of what anything "means."

**Accessibility tree** — a parallel representation of a page or app that's built specifically
so screen readers (software that reads a page aloud for blind/low-vision users) can describe
it sensibly: buttons, links, text fields, each with a "role" and a "name." It's often more
stable than raw markup, and — importantly — it also exists for native desktop apps, not just
web pages, which is why this system leans on it rather than raw HTML.

**Locator / selector** — the technical instruction for "which exact thing on the screen do you
mean." The choice of locator determines whether an automated action still works next month,
after the page has changed slightly.

**Test ID** — a special attribute developers sometimes add to a page specifically so
automated tools can find an element reliably (e.g. `data-testid="submit-button"`). Modern
apps built with automation in mind often have these. Legacy enterprise software essentially
never does — which is exactly the case this project is built for.

**Deterministic replay** — running a previously-recorded set of steps again, in exactly the
same way every time, with no AI model making any decisions. Same inputs in, same steps taken,
same kind of outputs out.

**Checkpoint** — a specific thing the system checks for to confirm it actually reached the
state it expected (e.g. "the page's address now ends in `/confirm`," or "the words 'Sub-account
opened successfully' are visible") — rather than just assuming a click worked because nothing
threw an error.

**Business outcome vs. failure** — a business outcome is a legitimate, expected answer the
system correctly recognized (e.g. "no member exists with that ID" — that's useful information,
not a crash). A failure is something genuinely unanticipated that the system couldn't explain.
Treating the first one like the second (crying "error!" over a normal answer) is called out in
the brief as the single most common mistake in this kind of system.

**Tenant** — one customer institution (one bank, one credit union). There are, in the real
world this project is modeled on, hundreds of them, and many run the exact same
behind-the-scenes software from the same vendor, just configured and branded differently for
each institution.

**Artifact / capability** — the reusable "recipe card" this system produces after a successful
first run: a precise, typed description of the steps, how to find each button/field, what
inputs it needs, what it returns, and how to tell it succeeded. "Capability" emphasizes that
an AI agent should be able to treat it like a function it can call by name.

**Guardrail** — a rule the system checks *before* doing anything, to make sure the action is
actually allowed and to treat especially risky actions (ones that can't easily be undone) with
extra caution.

**Escalation** — the act of a stuck or blocked automated process asking a human to step in.

**Handoff / control transfer** — the mechanism by which a human takes over an *in-progress,
live* session from the automation, and later gives it back, rather than starting over from
scratch or being handed only a written description of the problem.

---

## Software engineering fundamentals (for non-technical readers)

**Repository ("repo")** — the complete folder of all the project's files (code, docs,
configuration), tracked over time.

**Git** — a tool that keeps a complete history of every change ever made to a repository:
who changed what, when, and why (via a short message attached to each change). Think of it as
"track changes" for an entire project's files at once, forever, rather than just one document.
Every saved snapshot is called a **commit**. See
[`24-git-and-version-control.md`](24-git-and-version-control.md) for how this project actually
uses it.

**GitHub** — a website that hosts Git repositories online, so more than one person (or
computer) can see and contribute to the same project, and so a project can be shared publicly
(as this one is, per the brief's submission requirement).

**Branch** — a named, independent line of work within a repository (e.g. so you can try
something without touching the main, working version until you're sure). This project keeps
everything on one branch, `main`, since it's a small, single-contributor project — see
[`24-git-and-version-control.md`](24-git-and-version-control.md) for why that's a deliberate,
not accidental, choice.

**Commit message** — the short note attached to each saved snapshot describing what changed
and, more importantly, *why*. This repo's commit history is itself a form of documentation of
the project's evolution.

**Node.js** — the program that lets JavaScript (normally a language written for web browsers)
run directly on a computer or server, outside of any browser. This entire project runs on
Node.js.

**TypeScript** — a version of JavaScript with an extra layer of *type checking*: you declare
what "shape" of data a piece of code expects and returns, and a tool (`tsc`) checks, before
the code ever runs, whether everything is being used consistently. Think of it as a
spell-checker, but for the *shapes of data* flowing through the program, not the words. This
project is written entirely in TypeScript specifically so that a whole category of bugs
("I expected an object with a `name` field, but got a plain string") is caught before the code
is ever executed, not discovered live.

**npm ("Node Package Manager")** — both (a) the tool used to install other people's published
code so this project can reuse it instead of writing everything from zero, and (b) the
registry of publicly published packages it downloads from. `npm install` reads this project's
`package.json` (the list of what it depends on) and downloads everything needed into a
`node_modules` folder.

**`package.json`** — the project's own manifest: its name, its dependencies, and the list of
named shortcut commands (like `npm run replay`) that this documentation refers to constantly.

**Dependency / library / package** — a piece of someone else's published code this project
uses instead of writing itself (e.g. Express, for running a web server; Playwright, for
driving a browser).

**Unit test** — a small, automated check that a specific piece of code does exactly what it's
supposed to, run automatically (`npm test`), rather than a human manually re-checking it every
time something changes. See [`21-testing-strategy.md`](21-testing-strategy.md).

**Type-checking** — running the TypeScript checker (`npm run typecheck`) over the whole
project without actually running the program, to catch shape-of-data mistakes early.

**CI ("Continuous Integration")** — an automated process that runs a project's tests (and
other checks) every time someone proposes a change, *before* that change is allowed to be
considered "good," so mistakes are caught by a machine immediately rather than discovered
later by a person. See [`23-continuous-integration.md`](23-continuous-integration.md).

**Container / Docker** — a way of packaging a piece of software together with everything it
needs to run (the exact right versions of its dependencies, its configuration) into one
self-contained unit that behaves the same way no matter what computer it's started on. See
[`22-docker-and-containers.md`](22-docker-and-containers.md) for the full plain-language
explanation and why this project uses it for some parts but not others.

**Environment variable** — a small piece of configuration (like a secret password, or "which
port should this listen on") that's supplied to a program from *outside* its own code, rather
than being hard-coded inside it — specifically so secrets never end up written into the
project's files (and therefore never end up in Git history, or on GitHub, or anywhere public).
This project keeps them in a file called `.env`, which is deliberately excluded from Git (see
`.gitignore`).

**HTTP / endpoint / route** — the standard way computer programs talk to each other over a
network (the same underlying technology as loading a web page). An "endpoint" or "route" is
one specific thing a server knows how to respond to (e.g. `GET /capabilities` means "give me
the list of capabilities"; `POST /capabilities/:id/invoke` means "run this specific
capability").

**Playwright** — the specific tool this project uses to actually drive a real web browser
under program control: open a page, click a button, type into a field, take a screenshot, read
what's currently on screen.

**Headed vs. headless** — "headed" means the browser opens a real, visible window a person
could watch; "headless" means it runs invisibly in the background, faster and lighter, but
with nothing to actually look at. This project deliberately runs some things headed (anything
where a real human handoff matters) and offers headless for everything else.

---

## This project's own internal vocabulary

**Surface** — this project's own name for "the thing that lets us perceive and act on a UI,"
kept deliberately abstract so it isn't tied to "a web browser" specifically. See
[`03-surface-abstraction.md`](03-surface-abstraction.md).

**Discovery** — the first, AI-driven run of a task, before an artifact exists for it. See
[`04-discovery-agent.md`](04-discovery-agent.md).

**Replay** — running a previously-recorded artifact, deterministically, with no AI involved.
See [`06-deterministic-replay.md`](06-deterministic-replay.md).

**Known outcome** — a specific, expected "thing that can happen" that's been explicitly taught
to an artifact in advance (e.g. "no such member," "session timed out"), so replay recognizes
it by name instead of treating it as a mystery failure.

**Confidence / approval** — a score, and a gate, tracking whether a given artifact has proven
itself reliable enough to be trusted to run completely unattended. See
[`10-confidence-and-approval.md`](10-confidence-and-approval.md).

**Drift** — a sign that the software an artifact was recorded against has changed slightly
since recording (e.g. a button's exact wording changed), detected by noticing that replay had
to fall back to a lower-confidence way of finding something. See
[`12-ui-drift-detection.md`](12-ui-drift-detection.md).

**Tenant override** — a small, reviewed patch that adapts one artifact to a *second*
institution's differently-branded version of the same underlying software, without recording
a whole new artifact from scratch. See [`11-cross-tenant-reuse.md`](11-cross-tenant-reuse.md).

## Related docs

- [`00-problem-and-solution.md`](00-problem-and-solution.md)
- [`01-system-design.md`](01-system-design.md)
- [`README.md`](README.md) — full index
