# The Conversational Front End

## In one sentence

A natural-language request ("open a savings account for member 10001 with $100") is turned,
by exactly one AI decision, into a specific capability and typed arguments — and from that
point on, everything is the same deterministic capability API described in
[`14-capability-api.md`](14-capability-api.md); no AI ever touches execution or writes the
final answer.

---

## Part 1 — For everyone: a receptionist, not a caseworker

### The real-world analogy

Picture a receptionist at a busy office. You walk up and say, in your own words, "hi, I'd
like to open a savings account for member 10001, deposit $100 to start." The receptionist's
job is to *listen* and correctly fill out the right request form — ticking "open savings
account," writing "10001" in the member-ID box, "100" in the deposit box — and hand it to the
back office. The receptionist does **not** go do the task themselves, and they absolutely do
not make up an answer about how it went while you wait. The actual work happens exactly the
same way, through exactly the same process, whether the receptionist heard "I'd like to open
a savings account" or "yo, open me a savings account real quick" — the words differ, the form
that comes out the other side and the process that acts on it don't.

This project's conversational front end is that receptionist. Every other piece of this
system — replay, guardrails, the confidence gate — is "the back office": the part that
reliably and safely *does* things, described throughout the rest of this `docs/` folder. This
front end is deliberately the *only* piece that talks to a model in order to decide what to
do in the first place, and its job stops the moment it's filled out the form correctly.

### A concrete worked example, using the real demo command

```bash
npm run capability-api    # if not already running
npm run agent-chat -- --message "Using operator demo_operator and password demo_password, open a savings account for member 10001 with a starting deposit of 100 dollars"
```

What actually happens:

1. `agent-chat` first calls `GET /capabilities` — the exact same discovery call
   `agent-invoke-demo` makes (see [`14-capability-api.md`](14-capability-api.md)) — to find
   out what's available and what each one needs.
2. It hands the plain-English message to Gemini, along with one auto-generated "tool" per
   discovered capability, and asks for exactly one decision. The model picks
   `open-sub-account` and reads out the right values:
   ```
   Request: "Using operator demo_operator and password [REDACTED], open a savings account for member 10001 with a starting deposit of 100 dollars"
   Plan: invoke "open-sub-account" with {"memberId":"10001","accountType":"Savings","initialDeposit":"100","username":"demo_operator","password":"[REDACTED]"}
   Reasoning: ...
   ```
   Notice the password is already blacked out in this printout — more on why that mattered
   below.
3. From there, `agent-chat` calls `POST /capabilities/open-sub-account/invoke` — the *exact*
   same route `agent-invoke-demo` calls directly with hand-typed JSON. No model is involved
   in this step or in what comes next.
4. The final line printed is a deterministic summary built directly from the structured
   result — never a second model call asked to "phrase the response nicely":
   ```
   Done. confirmationNumber = ....
   ```
   or, for a member that doesn't exist, `Completed, but the answer is "member_not_found": ...`
   — the same three-way `success` / `business_outcome` / `failure` split every other part of
   this system uses (see [`06-deterministic-replay.md`](06-deterministic-replay.md)).

Mentioning a tenant by name — e.g. "...open this at Northgate Credit Union" — gets picked up
into the request's `tenantId` too, reusing the exact cross-tenant machinery
[`14-capability-api.md`](14-capability-api.md) already documents.

The same receptionist also stands at a real front desk, not just a terminal:
`npm run chat-ui` opens a real chat page at `http://localhost:4800` where a member can type
*or speak* the request (voice is the browser's own built-in speech recognition/synthesis —
nothing new to run, nothing audio-shaped ever sent anywhere). Notably, this front desk
**never asks the member for a password at all** — see Part 2's "How" for why that's a
deliberate design decision, not an oversight.

### "What happens if...?"

| Situation | What happens |
|---|---|
| The request never mentions a password at all | The model is not allowed to invent one, not even a placeholder — the field is simply left out, and the invocation fails validation explicitly and safely, rather than silently proceeding with a made-up credential. |
| The request does state a password in plain English | It's redacted before it's ever printed to the terminal — not after the API call, before it. |
| The request names a real member but a made-up account type | The invocation still goes through; the underlying capability API and replay engine reject bad parameters the same way they would for any other caller. |
| The member ID doesn't exist | `agent-chat` prints "Completed, but the answer is 'member_not_found'..." — a normal business answer, not an error, exactly like every other caller of this system. |
| The action would be risky and the artifact isn't approved yet | Declined automatically over HTTP — same outcome `agent-invoke-demo` sees for the same reason, since it's the same API underneath. |
| The request mentions a specific credit union by name | That name is picked up as a `tenantId` and that tenant's branded variant is invoked instead of the base capability. |
| Two different phrasings ask for the same thing ("open a savings account for 10001 with $100" vs. "10001 wants to start a savings account, $100 to open") | Both should resolve to the same capability and (ideally) the same arguments — the execution and the final report are identical either way, because they never depend on the wording, only on the structured plan that comes out of it. |
| The member types "$100" instead of "100" | Handled at the prompt level now — a real bug found by actually running this: the target app's own numeric parsing read a literal `"$100"` as `NaN` and misreported it as below the minimum deposit. Fixed by telling the model explicitly to strip currency symbols. |
| The member's browser doesn't support voice input (most don't fully implement it) | The mic button simply isn't shown at all — no broken control, no silent failure, typing still works exactly the same. |
| The chat page itself somehow got asked for operator credentials | It wouldn't matter — the chat UI's server injects its own configured service-account credential after planning, which always overrides anything a customer's message (or the model's own guess) supplied. |
| The member just says "hi," or asks a question that doesn't match any capability | A real bug, now fixed: this used to force a function call no matter what, and once used the literal word "hi" as a brand-new member's name — creating one for real. Now the model can reply in plain text and invoke nothing; verified against real Gemini that "hi" creates no member. |
| The request would create or change something (open a savings account, create a member, transfer funds, close an account) | Nothing is invoked yet. The chat bot first replies with a plain-language summary of exactly what it's about to do and asks the member to say "yes" or "no" — see "Confirm before executing anything risky" below. |
| The request only reads something (check a balance) | Answered immediately, no confirmation step — there's nothing to reconsider before a read happens. |
| The member replies "yes"/"confirm"/"go ahead" to a pending confirmation | The capability is invoked now, for real, with the exact data that was summarized. |
| The member replies "no"/"cancel"/"nevermind" to a pending confirmation | Nothing is invoked; the pending plan is discarded. |
| The member replies with something that's neither a clear yes nor a clear no (e.g. changes the subject) | The old pending plan is discarded rather than left dangling for a later, unrelated "yes" to accidentally confirm; the new message is planned fresh. |
| The bot asks a clarifying question (e.g. "what's the full name?") and the member answers with just that, in a separate message | Answered correctly, using the conversation's own history — see "Real conversation memory" below. A real bug, now fixed: each turn used to be planned with zero memory of the previous one, so an isolated "my full name is ..." reply matched nothing and the bot just repeated its capability list. |
| The member's own wording paraphrases the request itself ("I have to create one new member account") with no actual name anywhere in it | The model is now told explicitly not to extract action-describing words as if they were the entity's data — a real bug, now fixed: this exact phrasing once created a member literally named "one new member account." |
| A required field (like an operator username) is something the chat UI itself will supply, not the customer | The model never even sees that field as part of the capability's schema — a real bug, now fixed: it used to correctly refuse to invent a value, but that meant it kept asking the customer for an "operator username" they'd never know, blocking the whole request. |
| A confirmation message needs to show which capability is about to run | Plain quoting (`"create-member"`), not markdown `**bold**` — a real bug, now fixed: the chat page renders bot text as plain text on purpose, so asterisks showed up literally instead of rendering bold. |
| Opening the chat page in Safari specifically | Style and script now load correctly — a real bug, now fixed: helmet's default `Strict-Transport-Security` header, sent even over plain `http://localhost`, was being honored by Safari/WebKit, which then upgraded the *next* requests for `style.css`/`chat.js` to `https://localhost:4800/...` and failed outright (nothing answers TLS there). See `SECURITY.md`'s "Rate limiting & transport hardening" for the fix and — importantly — why a browser that already cached the old header for this host needs one manual site-data clear before it loads correctly again, even after this fix. |
| A message describes two steps where the second depends on the first ("create a member named Dave, then open a savings account for them with $100") | Detected as a chain (a deterministic text split, no model call), planned as two real plans, and confirmed together in one message — see "Chained requests" below. |
| The chained message's second clause has no concrete member reference at all when planned on its own | A real bug, now fixed: real Gemini correctly refused to call any function rather than invent one, breaking chain detection outright. A placeholder hint anchors the model's planning without ever being trusted as real data. |
| The first step of a chain doesn't cleanly succeed (a hard failure OR an unexpected business outcome) | The second step is never invoked — fails fast rather than inventing a value to continue with a broken first result. |

---

## Part 2 — For engineers: why, what, how, where

### Why

This is the other half of the sentence Section 1 of the brief frames the whole project
around: *"the agent-facing product decides what to do; this system is how it reliably and
safely does it."* Every other module in this repo is the second half. `src/frontend/planner.ts`
+ `src/cli/agent-chat.ts` are a small, honest slice of the *first* half — not a
general-purpose conversational agent, just enough to prove the seam actually connects: one
natural-language request maps to "which capability, with what typed args," and everything
downstream of that single decision is the exact same capability API that already existed.

The model's job **stops at deciding**. It never executes anything, and — deliberately — it
is never asked a second time to phrase the final response. `success`/`business_outcome`/
`failure` are templated deterministically straight from the structured `ReplayResult`
(`agent-chat.ts`'s `summarize()`). An extra LLM call to restate a result that's already
fully structured would only add latency, cost, and a brand-new hallucination surface, for
zero benefit — the same "the model decides, execution and reporting stay deterministic"
split the rest of the system is built around, held all the way to the front door.

### What

**`src/frontend/planner.ts`** — `planInvocation(genai, models, capabilities, utterance)`:

- Builds one Gemini `FunctionDeclaration` per discovered capability
  (`buildToolDeclarations`), named `invoke__<capabilityId>` (capability ids use hyphens;
  Gemini function names can't, so this is a reversible sanitization, not a rename).
- Each tool's parameters mirror the capability's own `inputParams`, plus a model-supplied
  `reasoning` string and an optional `tenantId`.
- Calls Gemini once with `functionCallingConfig.mode: AUTO` — the model may call at most one
  function, but is also allowed to call none at all and just reply in plain text. (This used
  to be `ANY`, forcing a call every turn; see "How" below for the real incident that changed
  it.)
- Returns a `PlanResult`: either `{ kind: "invoke", plan: CapabilityInvocationPlan }` or
  `{ kind: "clarify", message: string }` — the latter when the request doesn't clearly map to
  any capability (a greeting, small talk, a question), carrying the model's own conversational
  reply instead of a plan.
  ```typescript
  interface CapabilityInvocationPlan {
    capabilityId: string;
    params: Record<string, string>;
    tenantId?: string;
    reasoning: string;
  }
  ```

**`src/cli/agent-chat.ts`** — the CLI that ties it together: discovers capabilities via
`GET /capabilities`, calls `planInvocation`, redacts, prints, invokes via
`POST /capabilities/:id/invoke`, and prints a deterministic `summarize()` of the result.

### How — two real safety bugs found and fixed while building this

**1. The model inventing a placeholder credential.** Early on, a required-but-unstated
credential field got filled in with an invented placeholder value (something like
`"<REQUIRED>"`) to satisfy the function-calling schema's own `required` list — and the mock
bank's login form silently accepted it rather than rejecting it outright, which made the bug
easy to miss. The fix has two parts, both still in the code:

- `buildToolDeclarations()` in `planner.ts` deliberately **excludes `sensitive` params from
  the `required` list entirely**, even when the underlying capability itself marks them
  required:
  ```typescript
  required: ["reasoning", ...cap.inputParams.filter((p) => p.required && !p.sensitive).map((p) => p.name)],
  ```
  A credential belongs to the *calling system's authenticated session*, not to a string
  typed into a chat message — the planner's job is choosing *what* to call, never supplying
  *how* to authenticate. The system prompt reinforces this explicitly: "never invent a value
  for any field the request doesn't explicitly specify... this includes placeholder-looking
  values ('N/A', 'unknown', '<REQUIRED>', empty string) which are just as much an invention
  as a fake real-looking value."
- `replay-engine.ts`'s own `validateParams` was tightened to treat an **empty string as
  missing**, not provided — for *any* caller, not just this one. A field the model leaves
  out entirely and a field the model sets to `""` needed to fail validation the same way.

**2. Printing before redaction was armed.** The CLI's own console output originally printed
the raw utterance and the resolved params *before* redacting them — the same class of leak
`REPORT.md` already documents for the discovery agent's own goal string, just recurring in a
new front end that logs before it knows which fields are sensitive. The fix, still visible in
`agent-chat.ts` today, is to resolve the plan *first*, compute which keys/values are
sensitive (`redactionOptionsFor`), and only *then* make the first `console.log` call:

```typescript
const plan = await planInvocation(genai, MODELS, capabilities, message);
const redactOpts = redactionOptionsFor(capabilities, plan);
console.log(`\nRequest: "${redact(message, redactOpts)}"`);
```

`redactionOptionsFor()` is deliberately its own pure function (rather than inlined into
`main()`) so this decision is unit-testable without a live Gemini call — it builds both a
`sensitiveKeys` set (from the chosen capability's declared `sensitive` params) and a
`sensitiveValues` set (the actual values behind those keys in this specific plan), because
the raw utterance can carry a credential in plain English (e.g. "using password
demo_password...") that redaction-by-key alone wouldn't catch — only redaction-by-value
does. This was verified for real, not just asserted: `grep`-checking this CLI's own stdout
confirms the password never appears in cleartext there — the one caveat is npm's own
pre-execution argv echo at the shell level, a shell-level exposure common to every
`--password`/`--params` flag in this repo, which this fix cannot reach because it happens
before this process even starts.

### A real chat + voice UI, sharing one implementation with the CLI

`src/chat-ui/server.ts` is a small Express server plus a plain HTML/CSS/JS page (no build
step, no framework) at `http://localhost:4800`. It does not reimplement anything: both it
and `src/cli/agent-chat.ts` call the same `runChatTurn()` (`src/frontend/chat-turn.ts`,
extracted from the CLI for exactly this reason — one discover→plan→invoke implementation,
not two that could quietly drift apart). Voice is entirely client-side
(`src/chat-ui/public/chat.js`): `SpeechRecognition` for speech-to-text,
`speechSynthesis` for text-to-speech, both feature-detected, with the mic control removed
from the page entirely (not just disabled) on a browser that doesn't implement it.

**The one genuinely new problem this surface introduces: a customer should never be able to
supply — or need to know — a back-office credential.** `runChatTurn()` accepts an optional
`fillParams: Record<string, string>`, merged into the invoke call *after* planning and
**always winning** over anything the model itself proposed. The chat UI passes its own
configured service-account operator credential through it -- as of the unified,
multi-target console, that credential comes from whichever `TARGETS` entry (in
`src/chat-ui/server.ts`) the browser session has selected, not a single fixed env var: the
mock-bank target's own `fillParams`, or MERIDIAN's teller (`teller1`) vs. supervisor
(`super1`) identity, depending on which one is active. The CLI doesn't use this at all, since
an internal caller running the CLI is already the authenticated party. The injected value is
also never included in what's returned to *any* caller (`redactedParams` is built from the
plan *before* the merge), so even an internal debugging view can't accidentally surface it.

**A second, unrelated credential concept, added by the per-operator identity feature:** a
`TARGETS` entry's `fillParams` above is the target-system *sign-on* credential baked into
capability params. Separately, `CHAT_UI_SERVICE_API_KEY` (falling back to
`CAPABILITY_API_KEY` if unset) is which named entry in `config/operators.json` this
server's own *outbound HTTP call* to the capability API authenticates as -- setting it
means every chat-UI-originated run's evidence/audit trail says `chat-ui-service`, not
whichever human happens to own the shared key. See
[`19-security-and-authentication.md`](19-security-and-authentication.md) for the full
per-operator identity design; don't confuse the two "operator" ideas this file now
mentions.

This was verified for real, not just reasoned about, against a genuinely adversarial case:
with only one capability in this demo's catalog, a message that didn't cleanly match it
forced the model into a wrong-ish capability mapping — and, in the process, the model
fabricated a plausible-looking `username` value (`"test_user"`) for the one credential-shaped
field that isn't marked `sensitive`. The real evidence log for that exact run
(`evidence/runs/replay-2026-08-26T17-09-25-499Z/log.jsonl`) shows the operator that actually
signed on was the real configured one, not the fabricated one — confirming `fillParams`
overrides even a confident-looking guess, not only an obvious placeholder.

A second real bug surfaced the same way, unrelated to credentials: a request phrased with a
dollar sign ("...with $100") sometimes came back through the model as the literal string
`"$100"`. The target app's own `Number("$100")` parses to `NaN`, which its validation path
silently misreports as "below the $25 minimum" — a false negative, not a genuine validation
failure. Fixed in `planner.ts`'s own system prompt (supply the plain numeric value, no
currency symbol) and confirmed by re-running the exact same request against a live Gemini
call afterward, not just inspecting the prompt change.

### Confirm before executing anything risky

A chat member should never have something created or changed just because a model decided
that's what they meant — they should see exactly what's about to happen and say "yes" first.
This required splitting the single discover→plan→invoke sequence into two independently
callable halves:

- **`planChatTurn()`** (`src/frontend/chat-turn.ts`) — discovers capabilities and plans, same
  as before, but stops there. Returns `PlanChatTurnResult`: `{ kind: "clarified", ... }` (same
  as before) or `{ kind: "planned", plan, capability, redactedMessage, redactedParams,
  redactedReasoning, capabilities }` — note `capability` is the *matched* `DiscoveredCapability`
  itself, carrying `hasRiskyStep`.
- **`invokePlannedTurn()`** — takes that `planned` result and actually calls the capability
  API, exactly what the second half of the old `runChatTurn()` did.
- **`runChatTurn()`** itself is now just `planChatTurn()` followed by `invokePlannedTurn()` —
  unchanged behavior for `src/cli/agent-chat.ts`, which is used by an already-trusted internal
  operator and has no reason to gain a confirmation step.

`hasRiskyStep` is where the "risky" signal actually comes from: `GET /capabilities`
(`src/api/server.ts`) now includes `hasRiskyStep: artifact.steps.some(s => s.risk ===
"risky")` on every catalog entry — the same per-step risk data `GuardrailsPolicy` already
uses to gate execution, just surfaced one layer up so a caller can decide *whether to ask a
human* before ever reaching that gate. `DiscoveredCapability` in `planner.ts` carries the same
field through planning.

`src/chat-ui/server.ts` is the one caller that actually uses this split. It adds an
`express-session` (same memory-backed-session pattern `apps/mock-bank/src/server.ts` already
uses for its login) holding at most one `pendingPlan` per browser session:

1. A new message first checks whether a `pendingPlan` is waiting. If it is, and the message is
   a clear affirmative (`yes`/`confirm`/`go ahead`/...), the *stored* plan — not a freshly
   re-planned one — is invoked via `invokePlannedTurn()`, and the session is cleared. If it's a
   clear negative (`no`/`cancel`/`nevermind`/...), the plan is discarded and nothing is
   invoked. If it's neither, the stale pending plan is discarded and the new message is planned
   fresh — a later, unrelated "yes" must never be able to reattach to an old plan.
2. If there's no pending plan, the message is planned via `planChatTurn()`. If the matched
   capability's `hasRiskyStep` is `true`, the plan is stored in the session and a plain-language
   confirmation question is sent back — nothing is invoked yet. If it's `false` (a pure read,
   e.g. `check-balance`), it's invoked immediately, same as before — there's nothing to
   reconsider before a read happens.

No client-side changes were needed: `chat.js`'s `fetch("/chat", ...)` is same-origin, and
same-origin `fetch` sends cookies by default, so the session cookie round-trips automatically.

**A real bug this surfaced immediately, while testing it live against real Gemini calls, not
scripted ones:** the confirmation text for a "create a member" request initially read
`"...with username: , fullName: Priya Chen."` — a blank `username`. `username` is a required
field on `create-member`'s own schema but isn't marked `sensitive` (that flag governs
redaction, not who's allowed to supply a value), so the planner's function-calling schema
still lists it as required, and a real Gemini call invented an empty-string placeholder to
satisfy it — exactly the anti-pattern the system prompt tells it not to do, just for a field
the `sensitive` exclusion doesn't cover. Since `username`/`password` are always overwritten by
the chat UI's own `fillParams` before invoking regardless of what the model proposed, showing
the model's guess in the confirmation is pure noise, not a real value to confirm. Fixed by
having `describePendingPlan()` filter out any param name present in `fillParams` before
building the confirmation text.

Verified live end-to-end, independent of the chat replies themselves: with a cookie jar
preserving the session across two `curl` calls, a "create a member" request produced a clean
confirmation with no blank field; replying "yes" actually created the member, confirmed by
reading `apps/mock-bank/data/state.mock-bank.json` directly afterward; a second run replying
"no" instead left the member count and `nextMemberSeq` completely unchanged; and a plain
balance check invoked immediately with no confirmation step at all.

### Real conversation memory (and two more real bugs the first real multi-turn test found)

Every real chat is a back-and-forth, not one perfectly-specified sentence — the bot asks a
clarifying question, the member answers just that question in their next message, and the
bot needs to remember what was actually asked. This didn't work at all until now: each
`planInvocation` call sent Gemini exactly one isolated sentence, the current message, with no
memory of anything said before it.

**The core fix: `ConversationTurn[]` history, threaded all the way through.**
`planInvocation(genai, models, capabilities, utterance, history)` now prepends `history`
(oldest first) to the single-turn `contents` array it always sent, in Gemini's own
`{ role, parts }` shape (`role` is `"user"` or `"model"` — Gemini's multi-turn contract, not
this repo's invention). `history` entries are deliberately *what was actually said back* — the
clarifying question, or the deterministic result summary — never the internal
function-call/response plumbing; that's all a human follow-up needs to make sense of the
thread. `planChatTurn()` accepts the same `history` and passes it straight through.
`src/chat-ui/server.ts` is the one caller that keeps it: a `history` array lives in the same
`express-session` the pending-plan confirmation already uses, appended to (and trimmed to the
most recent `MAX_HISTORY_TURNS = 20` entries, so a long-running chat's token cost doesn't grow
without bound) after every single reply, regardless of which branch produced it.
`src/cli/agent-chat.ts` is one-shot and has no conversation to carry, so it never passes this
— `runChatTurn()`'s behavior for the CLI is unchanged.

Verified against real Gemini, replaying the exact conversation that failed before the fix:
"I want to create a new member account" (correctly asks for a name) → "my full name is Devin
Kumar Patel" now resolves and confirms correctly (it used to get answered as if it were an
unrelated, unmatched message, since the model had no idea a name had just been requested).

**A second real bug the same live test surfaced, unrelated to memory itself: the model
blocked an entire multi-turn `open-sub-account` request asking a customer for an "operator
username."** `username` is required by the capability's own schema but isn't marked
`sensitive` (only `password` is — see "How" above for why `sensitive` alone isn't a complete
signal). Once slot-filling worked well enough to reach every *other* field across several
turns, the model correctly refused to invent a `username` value for the one field left — but
that's exactly the field `fillParams` was always going to override anyway, so refusing to
proceed without it just stalled a request that had everything it actually needed. Fixed at
the schema level, not just the confirmation-display level the earlier `username: ` blank-value
bug was fixed at: `planChatTurn()` now filters any param name present in `fillParams` out of
the capability list *before* it ever reaches `planInvocation`/`buildToolDeclarations` — the
model never sees that parameter exists at all, so it can neither invent a value for it nor
block waiting for one. Verified live: the same multi-turn `open-sub-account` conversation
(member ID in one message, account type + deposit in the next) now reaches a clean
confirmation and a real, persisted sub-account with no username prompt anywhere in the
transcript.

**A third, purely cosmetic real bug, caught in the same round of live testing: a confirmation
read `"...run **create-member**..."` literally, asterisks and all.** `chat.js` renders every
bot message via `el.textContent`, deliberately (bot text can trace back to a customer's own
words or a model's own guess at a value, so it's never treated as HTML) — which also means it
was never going to render markdown `**bold**` either. Fixed by using plain quoting
(`"create-member"`) instead, matching the CLI's own console-output style.

### Chained requests: "create a member, then open an account for them"

A single chat message can now express two capability calls where the second genuinely
depends on the first's real output — e.g. *"create a new member named Priya Nair, then open
a savings account for them with $100."* This is deliberately **not** a model-driven
multi-call: a single Gemini turn can't produce step 2's real `memberId` at plan time, since
it doesn't exist until step 1 actually runs — asking the model to supply one anyway would
reintroduce exactly the "invent a plausible-looking value" failure mode already fixed once
in this project. So chain *detection* is a pure, deterministic text split on a small set of
connectors (`, then`, `and then`, `after that`, `once that's done`) — no model call, no real
value at stake, always safe to fall back to a normal single-capability turn if anything
about it doesn't line up (no connector found, either clause doesn't plan cleanly, or the two
chosen capabilities have no verified relationship).

`src/frontend/chain-mappings.ts` is the entire allowed chain surface, hand-authored rather
than inferred by matching field names automatically — `create-member`'s output is
`newMemberId`, but every consumer capability's input is `memberId`; there's no honest way to
match those names programmatically, so the four real, verified pairs are just listed:
`create-member` → `{open-sub-account, transfer-funds, check-balance, close-sub-account}`.
`src/frontend/chain.ts` builds on the existing, completely unmodified `planChatTurn()` — it
plans both clauses in parallel, and only if both come back as real plans (not `clarified`)
for a mapped capability pair does it report `{kind: "chained"}`. The chat UI holds this in a
new, independent `pendingChain` session field (never at the same time as the existing
`pendingPlan`) and shows ONE combined confirmation covering both steps — since every real
"from" capability today (`create-member`) is already risky, there's no unconfirmed-chain
case to handle. On "yes": step 1 is invoked for real; **fails fast** (never invokes step 2)
if step 1 comes back as anything other than a clean `success` — covering both a hard
`failure` and an unexpected `business_outcome`, since a broken first step has nothing real
to hand the second one. Only on a clean success is the real output value read and spliced,
unconditionally overwriting whatever the model itself proposed for that field, into step 2's
params before invoking it for real too.

**A real bug caught live, against real Gemini, not a hypothetical.** Planning the second
clause completely in isolation — "open a savings account for them with $100," with no
concrete member reference at all — made the model correctly refuse to call *any* function,
judging the request too unclear rather than inventing a value or leaving the field empty and
proceeding anyway. That's the exact behavior this system's own prompting has always wanted
out of the model — just not in a place this feature was ready for, since it broke chain
detection outright (both clauses must plan cleanly for a chain to be recognized at all).
Fixed with `MEMBER_ID_PLACEHOLDER_HINT`: the second clause's planning call gets an appended,
syntactically concrete placeholder ("...the member ID for this request is
CHAIN-STEP-1-MEMBER-ID") purely so the model has something to anchor `memberId` on and keeps
choosing the right capability — never trusted as real data, since whatever the model does
with it is unconditionally overwritten with step 1's actual output before step 2 is ever
invoked. **A second real bug this surfaced immediately afterward:** the placeholder value
itself leaked into the human-facing confirmation text ("...with memberId:
CHAIN-STEP-1-MEMBER-ID...") — the same class of bug as the earlier blank-`username`
confirmation issue, just a non-empty placeholder instead of an empty string. Fixed the same
way: the confirmation-building code hides `mapping.toField` from step 2's displayed params,
since it's never a real value to confirm at that point.

Verified live end-to-end against the real running services, not just the unit tests that
scripted this exact scenario: sending the literal sentence above produced a clean combined
confirmation with no placeholder visible; replying "yes" actually created a new member *and*
opened a real, correctly-linked sub-account for that exact new member id — confirmed by
reading `apps/mock-bank/data/state.mock-bank.json` directly afterward, not by trusting the
chat reply — and a separate run replying "no" instead created nothing at all.

### Where

- `src/frontend/planner.ts` — `planInvocation`, `buildToolDeclarations`, `toFunctionName`,
  the `CapabilityInvocationPlan` type, and `ConversationTurn` (the multi-turn history shape).
- `src/frontend/chat-turn.ts` — `runChatTurn()`, the one shared discover→plan→invoke
  sequence, including the `fillParams` credential-override mechanism (now also filtering
  `fillParams`-covered fields out of what the model's schema even exposes); also
  `planChatTurn()` and `invokePlannedTurn()`, the two halves it's built from, used directly by
  the chat UI's confirm-before-executing flow, and `planChatTurn()`'s own `history` parameter.
- `src/frontend/chat-shared.ts` — `InvokeResponse`, `redactionOptionsFor()`, `summarize()`,
  shared by the CLI and the web UI (re-exported from `agent-chat.ts` for backward
  compatibility with its own tests).
- `src/chat-ui/server.ts` + `src/chat-ui/public/` — the web UI: `handleChat()` (the exported
  `/chat` handler, extracted for direct unit testing without a real HTTP layer) with the
  `express-session`-backed `pendingPlan` confirmation flow, a `history` array of
  `ConversationTurn`s (capped at `MAX_HISTORY_TURNS`), and now `pendingChain` (an
  independent session field for a two-step chained request awaiting one combined
  confirmation) — plus the static page/styles/client script, unchanged.
- `src/frontend/chain-mappings.ts` — `CHAIN_MAPPINGS`, the hand-authored, verified
  output→input pairs a chain is allowed to splice across; `findChainMapping()`.
- `src/frontend/chain.ts` — `splitChainedUtterance()` (the deterministic connector split),
  `planChainedTurn()` (plans both clauses via the unmodified `planChatTurn()`), and
  `MEMBER_ID_PLACEHOLDER_HINT` (the real-bug fix described above).
- `src/cli/agent-chat.ts` — the CLI: argument parsing and console output around
  `runChatTurn()`.
- `src/replay/replay-engine.ts` — `validateParams`, tightened to treat empty string as
  missing for every caller.
- `src/guardrails/redaction.ts` — `redact()`, shared by this front end, the capability API,
  and evidence logging.
- `src/agent/model-retry.ts` — `withModelFallback`, the same transient-retry/daily-quota
  fallback used here as in discovery and assisted recovery.
- `src/api/server.ts` / `src/api/status.ts` — the exact downstream API this front end calls;
  see [`14-capability-api.md`](14-capability-api.md).

### A worked technical example

```bash
npm run agent-chat -- --message "Using operator demo_operator and password demo_password, open a savings account for member 10001 with a starting deposit of 100 dollars"
```

Real, representative output shape:

```
Discovering capabilities: GET http://localhost:4700/capabilities

Request: "Using operator demo_operator and password [REDACTED], open a savings account for member 10001 with a starting deposit of 100 dollars"
Plan: invoke "open-sub-account" with {"username":"demo_operator","password":"[REDACTED]","memberId":"10001","accountType":"Savings","initialDeposit":"100"}
Reasoning: The request explicitly asks to open a savings account for member 10001 with a $100 deposit, using the stated credentials.

HTTP 200
{
  "status": "success",
  "runId": "replay-...",
  "outputs": { "confirmationNumber": "..." }
}

Done. confirmationNumber = ....
```

### Edge cases & failure modes

- **`GEMINI_API_KEY` or `CAPABILITY_API_KEY` unset** — the CLI fails fast with an explicit
  error before making any network call, not a confusing downstream 401/model error.
- **No capabilities discovered yet** — `planInvocation` throws immediately
  ("No capabilities available to plan against") rather than asking a model to pick from an
  empty list.
- **Model calls an unknown function name** — treated as an error (`Model called unknown
  function "..."`), not silently ignored.
- **Model omits `reasoning` or `tenantId`** — both handled as optional/defaultable; only
  `tenantId` is passed through when it's a non-empty string.
- **A required, non-sensitive argument is missing from the utterance** — the model is
  instructed to still choose the best-matching capability and simply omit that argument; the
  *capability API's own* validation (not the planner) is what actually rejects the call, so
  the failure is explicit and safe rather than silently proceeding.
- **A sensitive argument's value appears verbatim in the free-text utterance** — caught by
  value-based redaction (`sensitiveValues`), not just key-based, before the first console log.
- **The model's underlying Gemini call hits a transient error or a daily quota exhaustion** —
  handled by the same `withModelFallback` every other model call in this repo uses; a
  transient blip retries with backoff, a daily-quota signal moves to the next model in
  `GEMINI_FALLBACK_MODELS`.
- **The shell itself echoes a `--message`/`--params` flag containing a credential** — a
  known, disclosed limitation at the OS/npm level, outside what any in-process redaction fix
  can reach.
- **The chat UI's own `GEMINI_API_KEY`/`CAPABILITY_API_KEY` are missing** — `/chat` returns a
  clear 500 before attempting any network call, rather than a confusing downstream failure.
- **A customer's message states a credential-looking value** — never used; `fillParams`
  always overrides it before the invoke call, verified against real evidence, not just the
  code path (see "A real chat + voice UI" above).
- **A pending confirmation is never answered (member closes the tab, or just stops
  responding)** — the session cookie expires (15-minute `maxAge`) and the plan is discarded
  with it; nothing is ever invoked without an explicit "yes."
- **Two risky requests in a row, the second before confirming the first** — not specially
  handled: the new message doesn't match the yes/no regexes, so the old pending plan is
  discarded and the new message is planned fresh (see "Confirm before executing anything
  risky" above) — the member would need to re-confirm the first request from scratch, which
  is the safe failure mode (never carrying forward what may have become a stale/wrong plan).
- **No per-customer identity or session** — deliberately not built for this demo (same "one
  caller class per surface, not a full identity system" posture `19-security-and-authentication.md`
  already discloses for the capability API and dashboard); a real deployment would need to
  know *which* member is chatting rather than asking them to state their own member ID.

## Related docs

- [`14-capability-api.md`](14-capability-api.md) — the exact API this front end calls, and
  where execution and guardrails actually live
- [`06-deterministic-replay.md`](06-deterministic-replay.md) — the three-way
  success/business_outcome/failure result this front end summarizes, never rephrases
- [`13-assisted-fallback-and-vision.md`](13-assisted-fallback-and-vision.md) — the other
  bounded, opt-in use of an LLM inside this system, for contrast with this front end's
  decide-only role
- [`00-problem-and-solution.md`](00-problem-and-solution.md) — the "agent decides, this
  system does it" framing this front end completes
- [`REPORT.md`](../REPORT.md) — "Agent-facing capability interface" section, "the other half
  of Section 1's sentence, made real"
