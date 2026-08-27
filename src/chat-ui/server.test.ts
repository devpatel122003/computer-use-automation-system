import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { fakeRes } from "../test-support/fixtures.js";

/**
 * Tests `handleChat` (the exported /chat route handler) directly with a fake req/res --
 * the same style src/http/api-key-auth.test.ts already uses for Express middleware. No new
 * test dependency (e.g. supertest) needed: underneath the HTTP framing, this is a
 * deterministic session state machine over `req.body`/`req.session`, both trivially
 * fakeable. `@google/genai` is mocked at the module level (via a mutable `router`, since
 * different tests need different scripted model responses) so no real Gemini call is ever
 * made; the capability API is a mocked `fetch`, same pattern as chat-turn.test.ts.
 */

type RouterResult = { name: string; args: Record<string, unknown> } | { text: string };
let router: (utterance: string) => RouterResult = () => ({ text: "unused" });

vi.mock("@google/genai", () => {
  // planner.ts also imports Type/FunctionCallingConfigMode from this same module, only to
  // build the outgoing request payload -- this mock's generateContent never inspects them
  // (it only reads req.contents), so plain sentinel values are enough; no need for the
  // real enums.
  function GoogleGenAI(this: unknown) {
    return {
      models: {
        generateContent: async (req: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
          const utterance = req.contents[req.contents.length - 1]?.parts?.[0]?.text ?? "";
          const result = router(utterance);
          if ("text" in result) return { candidates: [{ content: { parts: [{ text: result.text }] } }] };
          return { candidates: [{ content: { parts: [{ functionCall: { name: result.name, args: result.args, id: "call-1" } }] } }] };
        },
      },
    };
  }
  return {
    GoogleGenAI,
    Type: { STRING: "STRING", NUMBER: "NUMBER", BOOLEAN: "BOOLEAN", OBJECT: "OBJECT" },
    FunctionCallingConfigMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE" },
  };
});

let handleChat: typeof import("./server.js").handleChat;
let resolveTarget: typeof import("./server.js").resolveTarget;
let TARGETS: typeof import("./server.js").TARGETS;

beforeAll(async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.CAPABILITY_API_KEY = "test-capability-key";
  delete process.env.CHAT_UI_SERVICE_API_KEY;
  const mod = await import("./server.js");
  handleChat = mod.handleChat;
  resolveTarget = mod.resolveTarget;
  TARGETS = mod.TARGETS;
});

const CATALOG = [
  { id: "create-member", description: "Enrolls a new member.", hasRiskyStep: true, inputParams: [{ name: "fullName", type: "string", required: true }] },
  {
    id: "open-sub-account",
    description: "Opens a sub-account for a member.",
    hasRiskyStep: true,
    inputParams: [
      { name: "memberId", type: "string", required: true },
      { name: "accountType", type: "string", required: true },
      { name: "initialDeposit", type: "string", required: true },
    ],
  },
  { id: "check-balance", description: "Reads a member's balance.", hasRiskyStep: false, inputParams: [{ name: "memberId", type: "string", required: true }] },
  {
    id: "meridian-check-balance",
    description: "Reads a MERIDIAN member's balance.",
    hasRiskyStep: false,
    inputParams: [{ name: "memberId", type: "string", required: true }],
  },
  {
    id: "meridian-place-hold",
    description: "Places a hold on a MERIDIAN member's share.",
    hasRiskyStep: true,
    inputParams: [
      { name: "memberId", type: "string", required: true },
      { name: "shareId", type: "string", required: true },
      { name: "reasonCode", type: "string", required: true },
    ],
  },
];

function stubFetch(invokeResponses: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify(CATALOG), { status: 200 });
    const match = /\/capabilities\/([^/]+)\/invoke$/.exec(String(url));
    const id = match?.[1] ?? "";
    return new Response(JSON.stringify(invokeResponses[id] ?? { status: "success", outputs: {} }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function fakeReq(message: string, session: Record<string, unknown> = {}): Request {
  return { body: { message }, session } as unknown as Request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleChat -- regression lock: the existing single-capability confirm flow must be unaffected by chaining", () => {
  it("a risky, non-chained request gets a confirmation, not an immediate invocation", async () => {
    const calls = stubFetch();
    router = () => ({ name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } });

    const session: Record<string, unknown> = {};
    const res = fakeRes();
    await handleChat(fakeReq("create a new member named Dave", session), res);

    expect(res.body).toMatchObject({ reply: expect.stringContaining('"create-member"') });
    expect(session.pendingPlan).toBeDefined();
    expect(session.pendingChain).toBeUndefined();
    // Only the discovery call happened -- no invoke yet.
    expect(calls.filter((c) => c.url.includes("/invoke"))).toHaveLength(0);
  });

  it("confirming a pending single plan with 'yes' actually invokes it", async () => {
    stubFetch({ "create-member": { status: "success", outputs: { newMemberId: "20001" } } });
    router = () => ({ name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } });

    const session: Record<string, unknown> = {};
    await handleChat(fakeReq("create a new member named Dave", session), fakeRes());

    const confirmRes = fakeRes();
    await handleChat(fakeReq("yes", session), confirmRes);

    expect(confirmRes.body).toMatchObject({ reply: expect.stringContaining("newMemberId = 20001") });
    expect(session.pendingPlan).toBeUndefined();
  });

  it("declining a pending single plan with 'no' invokes nothing", async () => {
    const calls = stubFetch();
    router = () => ({ name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } });

    const session: Record<string, unknown> = {};
    await handleChat(fakeReq("create a new member named Dave", session), fakeRes());

    const declineRes = fakeRes();
    await handleChat(fakeReq("no", session), declineRes);

    expect(session.pendingPlan).toBeUndefined();
    expect(calls.filter((c) => c.url.includes("/invoke"))).toHaveLength(0);
  });
});

describe("handleChat -- multi-step chained requests", () => {
  function chainRouter(utterance: string): RouterResult {
    return utterance.includes("Dave")
      ? { name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } }
      // Real Gemini reliably fills memberId with the placeholder hint text (see chain.ts's
      // MEMBER_ID_PLACEHOLDER_HINT) rather than omitting the field -- scripted here to
      // match observed real behavior, not an idealized one.
      : { name: "invoke__open_sub_account", args: { reasoning: "r", memberId: "CHAIN-STEP-1-MEMBER-ID", accountType: "Savings", initialDeposit: "100" } };
  }

  it("a chained message produces one combined confirmation and holds pendingChain, not pendingPlan -- and never shows the internal placeholder value", async () => {
    stubFetch();
    router = chainRouter;

    const session: Record<string, unknown> = {};
    const res = fakeRes();
    await handleChat(fakeReq("create a new member named Dave, then open a savings account for them with $100", session), res);

    expect(res.body).toMatchObject({
      reply: expect.stringMatching(/"create-member".*"open-sub-account"/s),
    });
    expect(session.pendingChain).toBeDefined();
    expect(session.pendingPlan).toBeUndefined();
    // Regression: a real bug caught live -- the placeholder value used to anchor step 2's
    // planning call (chain.ts) isn't a real value yet and must never be shown to the human
    // as if it were one, the same "don't show a not-yet-real value" fix as the earlier
    // blank-username confirmation bug.
    expect((res.body as { reply: string }).reply).not.toContain("CHAIN-STEP-1-MEMBER-ID");
  });

  it("confirming with 'yes' invokes step 1, then splices its REAL output into step 2's params before invoking step 2", async () => {
    const calls = stubFetch({
      "create-member": { status: "success", outputs: { newMemberId: "20001" } },
      "open-sub-account": { status: "success", outputs: { confirmationNumber: "SA-00099" } },
    });
    router = chainRouter;

    const session: Record<string, unknown> = {};
    await handleChat(fakeReq("create a new member named Dave, then open a savings account for them with $100", session), fakeRes());

    const confirmRes = fakeRes();
    await handleChat(fakeReq("yes", session), confirmRes);

    expect(confirmRes.body).toMatchObject({
      reply: expect.stringMatching(/newMemberId = 20001.*confirmationNumber = SA-00099/s),
    });

    const openInvoke = calls.find((c) => c.url.includes("/open-sub-account/invoke"));
    const body = JSON.parse(String(openInvoke?.init?.body)) as { params: Record<string, string> };
    expect(body.params.memberId).toBe("20001");
    expect(session.pendingChain).toBeUndefined();
  });

  it("fails fast on a step-1 hard failure -- step 2's invoke endpoint is never called", async () => {
    const calls = stubFetch({ "create-member": { status: "failure", stepId: "step-3", expected: "x", observed: "y" } });
    router = chainRouter;

    const session: Record<string, unknown> = {};
    await handleChat(fakeReq("create a new member named Dave, then open a savings account for them with $100", session), fakeRes());

    const confirmRes = fakeRes();
    await handleChat(fakeReq("yes", session), confirmRes);

    expect(confirmRes.body).toMatchObject({ reply: expect.stringContaining("didn't continue to the next step") });
    expect(calls.filter((c) => c.url.includes("/open-sub-account/invoke"))).toHaveLength(0);
  });

  it("fails fast on a step-1 business_outcome (not just a hard failure) -- step 2's invoke endpoint is never called", async () => {
    const calls = stubFetch({ "create-member": { status: "business_outcome", outcome: "validation_error", description: "bad input" } });
    router = chainRouter;

    const session: Record<string, unknown> = {};
    await handleChat(fakeReq("create a new member named Dave, then open a savings account for them with $100", session), fakeRes());

    const confirmRes = fakeRes();
    await handleChat(fakeReq("yes", session), confirmRes);

    expect(confirmRes.body).toMatchObject({ reply: expect.stringContaining("didn't continue to the next step") });
    expect(calls.filter((c) => c.url.includes("/open-sub-account/invoke"))).toHaveLength(0);
  });

  it("declining a pending chain with 'no' invokes neither step, and a following ordinary message plans normally", async () => {
    const calls = stubFetch();
    router = chainRouter;

    const session: Record<string, unknown> = {};
    await handleChat(fakeReq("create a new member named Dave, then open a savings account for them with $100", session), fakeRes());

    const declineRes = fakeRes();
    await handleChat(fakeReq("no", session), declineRes);
    expect(session.pendingChain).toBeUndefined();
    expect(calls.filter((c) => c.url.includes("/invoke"))).toHaveLength(0);

    router = () => ({ name: "invoke__create_member", args: { reasoning: "r", fullName: "Someone Else" } });
    const nextRes = fakeRes();
    await handleChat(fakeReq("create a new member named Someone Else", session), nextRes);
    expect(session.pendingPlan).toBeDefined();
  });
});

describe("resolveTarget -- the single console's multi-target selection", () => {
  it("has at least mock-bank and a MERIDIAN teller/supervisor pair configured by default", () => {
    const ids = TARGETS.map((t) => t.id);
    expect(ids).toContain("mock-bank");
    expect(ids).toContain("meridian");
    expect(ids).toContain("meridian-supervisor");
  });

  it("falls back to the first target for an undefined or unknown id, never throwing", () => {
    expect(resolveTarget(undefined).id).toBe(TARGETS[0].id);
    expect(resolveTarget("not-a-real-target").id).toBe(TARGETS[0].id);
  });

  it("resolves a known id to its own entry, not the default", () => {
    expect(resolveTarget("meridian").id).toBe("meridian");
    expect(resolveTarget("meridian-supervisor").fillParams.username).toBe("super1");
  });
});

describe("handleChat -- target-aware routing (one console, multiple backends)", () => {
  it("with no activeTargetId set, invokes against the default (mock-bank) target's apiBase and identity", async () => {
    const calls = stubFetch({ "check-balance": { status: "success", outputs: { checkingBalance: "$1.00" } } });
    router = () => ({ name: "invoke__check_balance", args: { reasoning: "r", memberId: "10001" } });

    await handleChat(fakeReq("what's the balance for member 10001?", {}), fakeRes());

    const invoke = calls.find((c) => c.url.includes("/invoke"));
    expect(invoke?.url.startsWith(TARGETS[0].apiBase)).toBe(true);
    const body = JSON.parse(String(invoke?.init?.body)) as { params: Record<string, string> };
    expect(body.params.username).toBe(TARGETS[0].fillParams.username);
  });

  it("with activeTargetId set to a MERIDIAN target, invokes against ITS apiBase and injects ITS operator identity, not the default's", async () => {
    const meridian = TARGETS.find((t) => t.id === "meridian")!;
    const calls = stubFetch({ "meridian-check-balance": { status: "success", outputs: { primaryShareBalance: "$1.00" } } });
    router = () => ({ name: "invoke__meridian_check_balance", args: { reasoning: "r", memberId: "100234" } });

    const session: Record<string, unknown> = { activeTargetId: "meridian" };
    await handleChat(fakeReq("what's the balance for member 100234?", session), fakeRes());

    const invoke = calls.find((c) => c.url.includes("/invoke"));
    expect(invoke?.url.startsWith(meridian.apiBase)).toBe(true);
    const body = JSON.parse(String(invoke?.init?.body)) as { params: Record<string, string> };
    expect(body.params.username).toBe("teller1");
    expect(body.params.branch).toBe("MAIN-001");
  });

  it("with activeTargetId set to the supervisor variant, injects super1 -- same apiBase as the teller variant, different identity", async () => {
    const supervisor = TARGETS.find((t) => t.id === "meridian-supervisor")!;
    const teller = TARGETS.find((t) => t.id === "meridian")!;
    expect(supervisor.apiBase).toBe(teller.apiBase);

    const calls = stubFetch({ "meridian-place-hold": { status: "success", outputs: {} } });
    router = () => ({ name: "invoke__meridian_place_hold", args: { reasoning: "r", memberId: "102777", shareId: "102777-S0001", reasonCode: "LEGAL" } });

    const session: Record<string, unknown> = { activeTargetId: "meridian-supervisor" };
    await handleChat(fakeReq("place a hold on share 102777-S0001 for member 102777, reason LEGAL", session), fakeRes());
    // Risky capability -- first turn only plans/confirms, doesn't invoke yet.
    expect(session.pendingPlan).toBeDefined();

    await handleChat(fakeReq("yes", session), fakeRes());
    const invoke = calls.find((c) => c.url.includes("/invoke"));
    const body = JSON.parse(String(invoke?.init?.body)) as { params: Record<string, string> };
    expect(body.params.username).toBe("super1");
  });
});
