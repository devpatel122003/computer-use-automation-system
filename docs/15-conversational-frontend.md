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
- Calls Gemini once with `functionCallingConfig.mode: ANY` — forced to make exactly one
  call, the same discipline the discovery loop uses for the same reason: one unambiguous
  decision, not a menu of options or a free-text ramble beside it.
- Returns a `CapabilityInvocationPlan`:
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

### Where

- `src/frontend/planner.ts` — `planInvocation`, `buildToolDeclarations`, `toFunctionName`,
  the `CapabilityInvocationPlan` type.
- `src/cli/agent-chat.ts` — the CLI: discovery, redaction wiring (`redactionOptionsFor`),
  invocation, `summarize()`.
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
