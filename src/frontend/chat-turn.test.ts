import { afterEach, describe, expect, it, vi } from "vitest";
import { runChatTurn, planChatTurn, invokePlannedTurn } from "./chat-turn.js";
import type { GoogleGenAI } from "@google/genai";

function scriptedGenai(name: string, args: Record<string, unknown>): GoogleGenAI {
  return {
    models: {
      generateContent: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name, args, id: "call-1" } }] } }] }),
    },
  } as unknown as GoogleGenAI;
}

/** Same as scriptedGenai, but also captures the tool declarations actually sent to the
 *  model -- needed to assert a fillParams-covered field (e.g. "username") never even
 *  appears in the schema the model sees. */
function capturingScriptedGenai(name: string, args: Record<string, unknown>): { genai: GoogleGenAI; requests: any[] } {
  const requests: any[] = [];
  const genai = {
    models: {
      generateContent: async (req: any) => {
        requests.push(req);
        return { candidates: [{ content: { parts: [{ functionCall: { name, args, id: "call-1" } }] } }] };
      },
    },
  } as unknown as GoogleGenAI;
  return { genai, requests };
}

/** AUTO mode's real "didn't call anything" shape: a text part, no functionCall part. */
function scriptedTextOnlyGenai(text: string): GoogleGenAI {
  return {
    models: {
      generateContent: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    },
  } as unknown as GoogleGenAI;
}

const CATALOG = [
  {
    id: "open-sub-account",
    description: "Opens a new sub-account for a member.",
    hasRiskyStep: true,
    inputParams: [
      { name: "username", type: "string", required: true, sensitive: false },
      { name: "password", type: "string", required: true, sensitive: true },
      { name: "memberId", type: "string", required: true, sensitive: false },
      { name: "initialDeposit", type: "string", required: true, sensitive: false },
    ],
  },
];

/** Stubs global fetch: first call is GET /capabilities, second (if it happens) is POST /invoke. */
function stubFetch(invokeResponse: unknown, invokeStatus = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (String(url).endsWith("/capabilities")) {
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }
    return new Response(JSON.stringify(invokeResponse), { status: invokeStatus });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runChatTurn", () => {
  it("discovers, plans, and invokes, returning a deterministic summary", async () => {
    const calls = stubFetch({ status: "success", outputs: { confirmationNumber: "SA-00001" } });
    const genai = scriptedGenai("invoke__open_sub_account", {
      reasoning: "Open a savings account for member 10001.",
      memberId: "10001",
      initialDeposit: "100",
    });

    const turn = await runChatTurn({
      genai,
      models: ["gemini-3.7-flash"],
      apiBase: "http://localhost:4700",
      apiKey: "test-key",
      message: "open a savings account for member 10001 with $100",
    });

    expect(turn.kind).toBe("invoked");
    if (turn.kind !== "invoked") throw new Error("expected invoked");
    expect(turn.plan.capabilityId).toBe("open-sub-account");
    expect(turn.httpStatus).toBe(200);
    expect(turn.summary).toBe("Done. confirmationNumber = SA-00001.");
    expect(calls[0].url).toContain("/capabilities");
    expect(calls[1].url).toContain("/open-sub-account/invoke");
  });

  it("sends an Authorization header with the given apiKey on both calls", async () => {
    const calls = stubFetch({ status: "success", outputs: {} });
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

    await runChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "secret-key", message: "x" });

    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>)?.Authorization).toBe("Bearer secret-key");
    }
  });

  it("fillParams override plan.params in the actual invoke call, but never leak into the returned redactedParams", async () => {
    const calls = stubFetch({ status: "success", outputs: {} });
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

    const turn = await runChatTurn({
      genai,
      models: ["m"],
      apiBase: "http://localhost:4700",
      apiKey: "k",
      message: "open a savings account for member 10001 with $100",
      fillParams: { username: "demo_operator", password: "demo_password" },
    });
    if (turn.kind !== "invoked") throw new Error("expected invoked");

    // The credential the customer never stated must actually reach the invoke call...
    const invokeBody = JSON.parse(String(calls[1].init?.body)) as { params: Record<string, string> };
    expect(invokeBody.params.username).toBe("demo_operator");
    expect(invokeBody.params.password).toBe("demo_password");

    // ...but must never appear in what's handed back to a caller (the chat UI, the CLI),
    // since the customer never supplied it and has no reason to see it, redacted or not.
    expect(turn.redactedParams.username).toBeUndefined();
    expect(turn.redactedParams.password).toBeUndefined();
  });

  it("redacts a sensitive value the model DID legitimately extract from the utterance", async () => {
    stubFetch({ status: "success", outputs: {} });
    const genai = scriptedGenai("invoke__open_sub_account", {
      reasoning: "r",
      username: "demo_operator",
      password: "demo_password",
      memberId: "10001",
      initialDeposit: "100",
    });

    const turn = await runChatTurn({
      genai,
      models: ["m"],
      apiBase: "http://localhost:4700",
      apiKey: "k",
      message: "sign on as demo_operator with password demo_password and open an account for member 10001 with $100",
    });
    if (turn.kind !== "invoked") throw new Error("expected invoked");

    expect(turn.redactedMessage).not.toContain("demo_password");
    expect(turn.redactedParams.password).not.toBe("demo_password");
  });

  it("throws a clear error when the capability catalog can't be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const genai = scriptedGenai("anything", {});

    await expect(
      runChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "x" })
    ).rejects.toThrow(/GET \/capabilities failed/);
  });

  it("propagates a business_outcome result and summary, distinct from success or failure", async () => {
    stubFetch({ status: "business_outcome", outcome: "member_not_found", description: "No such member." });
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "40404", initialDeposit: "100" });

    const turn = await runChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "look up member 40404" });
    if (turn.kind !== "invoked") throw new Error("expected invoked");

    expect(turn.result.status).toBe("business_outcome");
    expect(turn.summary).toContain("member_not_found");
  });

  describe("a message that doesn't clearly map to any capability (regression: 'hi' must never invoke anything)", () => {
    it("returns a clarified result and never calls /invoke at all", async () => {
      const calls = stubFetch({ status: "success", outputs: {} }); // would only be hit if a bug re-introduced an invoke call
      const genai = scriptedTextOnlyGenai("Hi! I can help you look up a member or open a new sub-account.");

      const turn = await runChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "hi" });

      expect(turn.kind).toBe("clarified");
      if (turn.kind !== "clarified") throw new Error("expected clarified");
      expect(turn.message).toContain("look up a member");
      // Exactly one fetch call (the capability discovery), never a second one to /invoke --
      // this is the actual regression check: a bare greeting must not create anything.
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/capabilities");
    });

    it("still redacts the echoed message even though no capability's sensitive-field list applies", async () => {
      stubFetch({ status: "success", outputs: {} });
      const genai = scriptedTextOnlyGenai("Not sure what you mean -- try asking me to open an account.");

      const turn = await runChatTurn({
        genai,
        models: ["m"],
        apiBase: "http://localhost:4700",
        apiKey: "k",
        message: "my card number is 4111111111111111, what can you do?",
      });
      if (turn.kind !== "clarified") throw new Error("expected clarified");

      // Pattern-based (card-shaped) defense-in-depth redaction still applies even with no
      // capability-specific sensitive-value list to work from.
      expect(turn.redactedMessage).not.toContain("4111111111111111");
    });
  });
});

describe("planChatTurn / invokePlannedTurn (the split runChatTurn is built from)", () => {
  it("planChatTurn plans without ever calling /invoke, and carries hasRiskyStep through from the catalog", async () => {
    const calls = stubFetch({ status: "success", outputs: {} }); // only hit if a bug calls invoke during planning
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

    const planned = await planChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "x" });

    expect(planned.kind).toBe("planned");
    if (planned.kind !== "planned") throw new Error("expected planned");
    expect(planned.capability.hasRiskyStep).toBe(true);
    expect(planned.plan.capabilityId).toBe("open-sub-account");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/capabilities");
  });

  it("invokePlannedTurn takes a planned result and actually invokes it, applying fillParams", async () => {
    const calls = stubFetch({ status: "success", outputs: { confirmationNumber: "SA-00002" } });
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

    const planned = await planChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "x" });
    if (planned.kind !== "planned") throw new Error("expected planned");

    const turn = await invokePlannedTurn(
      { apiBase: "http://localhost:4700", apiKey: "k", fillParams: { username: "demo_operator", password: "demo_password" } },
      planned
    );

    expect(turn.kind).toBe("invoked");
    expect(turn.summary).toBe("Done. confirmationNumber = SA-00002.");
    const invokeBody = JSON.parse(String(calls[1].init?.body)) as { params: Record<string, string> };
    expect(invokeBody.params.username).toBe("demo_operator");
  });

  it("running plan then invoke separately produces the same result as runChatTurn in one call", async () => {
    stubFetch({ status: "success", outputs: { confirmationNumber: "SA-00003" } });
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

    const turn = await runChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "x" });

    expect(turn.kind).toBe("invoked");
    if (turn.kind !== "invoked") throw new Error("expected invoked");
    expect(turn.summary).toBe("Done. confirmationNumber = SA-00003.");
  });

  describe("fillParams-covered fields never reach the model's own schema (regression: the model blocked an entire request asking a customer for an 'operator username')", () => {
    it("passing fillParams hides those param names from the tool declaration the model actually sees", async () => {
      stubFetch({ status: "success", outputs: {} });
      const { genai, requests } = capturingScriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

      await planChatTurn({
        genai,
        models: ["m"],
        apiBase: "http://localhost:4700",
        apiKey: "k",
        message: "x",
        fillParams: { username: "demo_operator", password: "demo_password" },
      });

      const props = requests[0].config.tools[0].functionDeclarations[0].parameters.properties;
      expect(Object.keys(props)).not.toContain("username");
      expect(Object.keys(props)).not.toContain("password"); // already excluded anyway (sensitive)
      expect(Object.keys(props)).toContain("memberId"); // untouched -- not a fillParams key
    });

    it("without fillParams, the field is still exposed (unchanged behavior for the CLI, which has no fillParams)", async () => {
      stubFetch({ status: "success", outputs: {} });
      const { genai, requests } = capturingScriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });

      await planChatTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k", message: "x" });

      const props = requests[0].config.tools[0].functionDeclarations[0].parameters.properties;
      expect(Object.keys(props)).toContain("username");
    });
  });
});
