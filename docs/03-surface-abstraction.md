# The Surface Abstraction

## In one sentence

Everything above this layer — the discovery agent, guardrails, replay, escalation — perceives
and acts on a target application through one narrow interface called `Surface`, so that
"drive a legacy web app with Playwright" is just *one* implementation of it, not the only
thing this system could ever be pointed at.

---

## Part 1 — For everyone: how the robot arm sees and touches things

### The analogy

Imagine hiring a temp worker to operate a front-desk computer they've never seen before. You
wouldn't teach them "this specific bank's software" — you'd teach them a general skill: "look
at the screen, find the buttons and text boxes, read their labels, click the right one, type
into the right one." That general skill works whether the software in front of them was built
last year or in 2003, and it would keep working even if you sat them down at a totally
different kind of computer (a Mac desktop app instead of a browser tab) — because the *skill*
of "look, then act" doesn't care what's underneath it.

`Surface` is this project's name for that general skill, written down as a strict contract
(a TypeScript `interface`, in `src/surface/types.ts`) instead of a person's intuition. Every
other part of the system — the AI that learns a task, the code that decides "is this allowed?",
the code that replays a recorded recipe — only ever talks to a `Surface`. None of it knows or
cares that, today, the one real implementation happens to be a Chromium browser tab driven by
Playwright. If interface.ai someday needed to automate a Windows desktop app with no browser
involved at all, only one file would need to change (a new implementation of `Surface`) — the
discovery agent, the guardrails, and the replay engine would not need to know anything happened.

### What "observing" mock-bank's login page actually looks like

The demo target app, `mock-bank`, renders its sign-on page (`apps/mock-bank/views/login.ejs`)
the way a lot of real 20-year-old back-office software still does: a `<table>`-based layout,
`<font color="#ffffff">` tags for styling, no CSS classes, no `data-testid` attributes anywhere.
A person looks at it and sees "a box labeled Operator ID, a box labeled Password, a button
labeled Sign On." That is exactly what `Surface.observe()` hands back too — not raw HTML, a
flattened list of elements with a role and a name, e.g.:

```
- [textbox] "Operator ID"
- [textbox] "Password"
- [button] "Sign On"
```

(This is a simplified version of the real observation format the agent reads — see
[`04-discovery-agent.md`](04-discovery-agent.md) for the exact text format. The "Password"
box is additionally flagged internally as `sensitive: true`, so its value is never written to
a log file in cleartext.)

"Acting" — say, clicking the real "Sign On" button on that page — means: the caller says
"click the button named Sign On," `Surface` figures out *how* to actually locate that button
in today's page markup (there's no `id="signOn"` to lean on — this button is a plain
`<input type="submit" value="Sign On">` three tables deep), clicks it, waits for the resulting
page load, and reports back whether it worked and what URL the browser ended up on.

### "What happens if...?" — real scenarios this abstraction handles

| Situation | What happens |
|---|---|
| The page is a `<table>`-and-`<font>` layout with zero CSS classes or test IDs (mock-bank's actual login page) | `Surface` still produces a clean role/name list — it walks the raw DOM structure itself rather than depending on modern markup conventions. |
| The same button's most-preferred way of being found (its accessible role+name) stops working — say a future redesign wraps it differently | `Surface` automatically falls back to the next-best way of finding it (matching its visible text, then its position in the page), rather than failing outright. |
| Two buttons on the page happen to have the exact same visible label | Each one is tagged with a position number (`nth`) so "the second one" can still be told apart from "the first one." |
| A password field | It's still described as a textbox — but flagged `sensitive`, so nothing above this layer ever writes its actual contents into an evidence log. |
| A future desktop-only, non-browser target app | Nothing above `Surface` needs to change — a new class implementing the same four methods (`observe`, `perform`, `predictNavigation`, `screenshot`, `currentUrl`, `getVisibleText`, `close`) against, say, OS accessibility APIs would slot in exactly where `PlaywrightSurface` does today. |
| Guardrails need to know "where would clicking this actually take us?" *before* it happens | `predictNavigation()` answers that without performing the click at all — see the forward-reference below and the full story in [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md). |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief's hardest case isn't "a web app with messy HTML" — it's "no API exists, so the only
integration surface is whatever a human employee looks at," and that could just as well be a
native desktop application someday (the brief explicitly names this: "a native desktop
application... the only reliable surface is what a human operator sees and does"). If the
discovery agent, guardrails, and replay engine were written directly against Playwright's
`Page` object, every one of them would be permanently coupled to "this is a browser," and
adding a second kind of surface later would mean touching all of them. The fix is to put one
seam in exactly one place.

### What

`Surface` (`src/surface/types.ts`) is a TypeScript interface with seven methods:

```ts
export interface Surface {
  observe(): Promise<StateSnapshot>;
  perform(action: Action): Promise<ActionResult>;
  predictNavigation(action: Action): Promise<PredictedNavigation | null | undefined>;
  getVisibleText(): Promise<string>;
  screenshot(label: string): Promise<string>;
  currentUrl(): string;
  close(): Promise<void>;
}
```

- **`observe()`** returns a `StateSnapshot`: the page's `url`, `title`, a screenshot path, and
  an `elements: ObservedElement[]` array — a flattened, role-based view (`ElementRole` is one
  of `"button" | "link" | "textbox" | "combobox" | "checkbox" | "radio" | "text"`). Each
  `ObservedElement` already carries its own `locatorCandidates: LocatorCandidate[]` — the
  chain of ways it could later be re-found — computed at observe time, not invented later.
- **`perform(action)`** executes one `Action` (`navigate` / `click` / `type` / `select_option`
  / `extract` / the vision-only `click_coordinates`) and returns an `ActionResult`: `ok`,
  an optional `error`, which `matchedStrategy` actually worked, and the resulting `url`.
- **`predictNavigation(action)`** is read-only: "if this action ran, where would it go, without
  actually doing it?" It exists specifically for guardrails to authorize a `click`/`navigate`
  *before* it happens. It returns one of three distinct things, each meaning something
  different — this three-way return type is deliberate, not an oversight:
  - a `PredictedNavigation { url, method }` — the destination is known;
  - `null` — the element resolved, but its destination is genuinely ambiguous (no enclosing
    `<form>` or `<a>` — e.g. a JS-driven write); guardrails treat this as **fail closed**;
  - `undefined` — the target element didn't resolve on the page at all, so there's nothing to
    authorize; `perform()` is about to fail on its own, and that failure flows through normal
    known-outcome handling, not the guardrail layer.

  Full detail on how guardrails consume this lives in
  [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the short version is that
  `predictNavigation` is what lets the allowlist check "is `POST /members/10001/sub-accounts`
  allowed?" *before* clicking Submit, instead of after the write has already happened.
- **`getVisibleText()`**, **`screenshot()`**, **`currentUrl()`**, **`close()`** round out what
  checkpoints, evidence, and cleanup need.

### How

**`PlaywrightSurface`** (`src/surface/playwright-surface.ts`) is the one real implementation,
backed by `chromium.launch()`. Two pieces of it matter most:

1. **The DOM walker, `scanPage()`** (`src/surface/dom-scan.ts`), runs *inside* the browser
   page via `page.evaluate()` and is deliberately self-contained (no closures over outer
   variables — Playwright serializes only the function's own source text into the page).
   It builds the flattened role list two passes:
   - Interactive controls first: every visible `a[href], button, input, select, textarea`
     becomes one entry, with its role inferred from tag/type (`input[type=password]` →
     `textbox` + `sensitive: true`; `input[type=submit]` → `button`; etc.), and its name
     resolved through a small priority chain in `labelForInput()`: an associated
     `<label for=...>`, then `aria-label`, then `placeholder`, then the raw `name` attribute.
   - Leaf text nodes second, for error-banner/extraction detection — but only elements whose
     content is plain text or purely *inline formatting*. A dedicated check,
     `isInlineOnlyContent()`, walks an element's children and only treats it as a leaf if
     every child is one of `INLINE_ABSORB_TAGS` (`b`, `font`, `strong`, `em`, `i`, `tt`, `u`,
     `sub`, `sup`) and is itself inline-only. This exists because of real markup in this
     app's error banners: `<font><b>Access denied.</b> the rest of the message</font>` — without
     absorbing the `<b>` and `<font>` wrapper into the container, a naive DOM walk would only
     surface the bolded fragment "Access denied." and silently drop the rest of the sentence
     a `text_match` checkpoint might need.
   - A `cssPathFor()` helper walks up to either an `id` or the document root, building an
     `nth-of-type` structural path — this becomes the *last-resort* `css_structural` locator
     candidate, never the first choice.

2. **Locator fallback chains, built in `buildLocatorCandidates()`** (in
   `playwright-surface.ts`, called from `observe()`). For every observed element, up to four
   `LocatorCandidate`s are proposed, most to least robust:
   - `test_id` (confidence `high`) — only if a `data-testid` attribute exists (mock-bank's
     legacy views never have one, so this tier is usually empty in this demo).
   - `role` + `name` (confidence `high` if unique on the page, `medium` if disambiguated by
     position).
   - `text` — an exact visible-text match (confidence `medium`).
   - `css_structural` — the nth-of-type DOM path (confidence `low`, "brittle to markup
     reordering, used only if the above fail").

   At *resolve* time (`resolveCandidate()`/`resolve()`), each candidate is tried in order
   against the live page; the first one that both matches an element *and* is currently
   visible wins — an invisible `display:none` match is explicitly rejected rather than treated
   as found, so a stale/hidden element with a coincidentally matching name can't satisfy a
   checkpoint. Which strategy actually matched is reported back on `ActionResult.matchedStrategy`
   — that single field is the UI-drift signal used elsewhere in the system (see
   [`12-ui-drift-detection.md`](12-ui-drift-detection.md)).

**Trade-off made here:** locator candidates are computed once, at `observe()` time, and
carried on the `ObservedElement` itself rather than recomputed lazily when an action executes.
This means the discovery agent's decision ("click the button named X") and the artifact
recorder both work from the exact same candidate list that was actually observed — there's no
second, slightly-different code path that could compute a different set of fallbacks later.

### Where

- `src/surface/types.ts` — the `Surface` interface, `Action`, `ActionResult`,
  `PredictedNavigation`, `ObservedElement`, `LocatorCandidate`, `StateSnapshot`.
- `src/surface/playwright-surface.ts` — `PlaywrightSurface`, the only implementation today;
  also exposes `getPage()` so [`08-escalation-and-handoff.md`](08-escalation-and-handoff.md)
  can hand the *same* live page to a human.
- `src/surface/dom-scan.ts` — `scanPage()`, run in-browser.
- Consumers: `src/agent/discovery-agent.ts` calls `observe()`/`perform()` every turn;
  `src/guardrails/policy.ts`'s `GuardrailsPolicy.authorize()` calls `predictNavigation()`
  before every action, in both discovery and replay; `src/replay/replay-engine.ts` calls
  `perform()` deterministically per artifact step.

### Worked technical example

Given mock-bank's real login markup (`apps/mock-bank/views/login.ejs` — an `<input
type="submit" value="Sign On">` nested three tables deep, no `id`, no test ID), the "Sign On"
button's real recorded locator chain — taken directly from
`evidence/artifacts/open-sub-account.artifact.json`, step-4 — is:

```json
[
  { "strategy": "role", "role": "button", "name": "Sign On", "nth": 0, "confidence": "high",
    "rationale": "Accessible role + name uniquely identifies this control, independent of markup/CSS." },
  { "strategy": "text", "name": "Sign On", "nth": 0, "confidence": "medium",
    "rationale": "Exact visible text match; stable as long as copy doesn't change." },
  { "strategy": "css_structural",
    "cssPath": "body > table:nth-of-type(2) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1) > form:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(3) > td:nth-of-type(1) > input:nth-of-type(1)",
    "nth": 0, "confidence": "low",
    "rationale": "Structural DOM position fallback; brittle to markup reordering, used only if the above fail." }
]
```

No `test_id` tier is present at all — this app never sets `data-testid`, which is the ordinary
case this system is built for, not an edge case.

### Edge cases & failure modes

- **No locator candidate resolves at all** — `resolve()` returns `null`, `perform()` returns
  `{ ok: false, error: "No locator candidate resolved to an element." }`. This is *not* raised
  as a guardrail block; it flows into the discovery loop's normal dead-end/known-outcome
  handling (see [`04-discovery-agent.md`](04-discovery-agent.md)).
- **A click's destination is genuinely ambiguous** (a JS `onclick` with no enclosing `<form>`
  or `<a href>`) — `predictNavigation()` returns `null`, and `GuardrailsPolicy.authorize()`
  fails closed rather than assuming it's safe.
- **A checkpoint or action targets an element that's technically in the DOM but hidden** — the
  visibility check in `resolveCandidate()` treats it as not found, preferring a visible
  lower-priority candidate over an invisible higher-priority one.
- **A vision-only fallback click** (`click_coordinates`) never has a `LocatorCandidate` at all,
  by design — it's produced only by the replay engine's bounded, opt-in assisted-recovery path
  (`src/replay/assisted-recovery.ts`), never by discovery, and never stored on a recorded
  artifact step. See [`10-confidence-and-approval.md`](10-confidence-and-approval.md) and
  [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md) for why.
- **`observe()` accidentally drops part of an error message** — the specific failure mode the
  `INLINE_ABSORB_TAGS`/`isInlineOnlyContent` logic in `dom-scan.ts` exists to prevent; see
  "How" above.

## Related docs

- [`01-system-design.md`](01-system-design.md) — where Surface sits in the overall module map
- [`04-discovery-agent.md`](04-discovery-agent.md) — the loop that calls `observe()`/`perform()` every turn
- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the other consumer of `Surface`, with zero model calls
- [`07-guardrails-and-safety.md`](07-guardrails-and-safety.md) — the full story on `predictNavigation()` and fail-closed authorization
- [`12-ui-drift-detection.md`](12-ui-drift-detection.md) — how `matchedStrategy` becomes a drift signal
- [`REPORT.md`](../REPORT.md) — "1. Architecture" for the original design rationale
