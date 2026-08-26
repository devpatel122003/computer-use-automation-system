import { describe, expect, it } from "vitest";
import { buildToolDeclarations, planInvocation, type DiscoveredCapability } from "./planner.js";
import type { GoogleGenAI } from "@google/genai";

/**
 * Same discipline as discovery-agent.test.ts: fake the model's *output* with a scripted
 * function call, not its judgment. This tests the plan-extraction mechanics (does the
 * sanitized function name map back to the right capability id? do reasoning/tenantId get
 * pulled out of params correctly?), not a claim about what real Gemini would decide to call.
 */
function scriptedGenai(name: string, args: Record<string, unknown>): GoogleGenAI {
  return {
    models: {
      generateContent: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name, args, id: "call-1" } }] } }] }),
    },
  } as unknown as GoogleGenAI;
}

/** AUTO mode's real "didn't call anything" shape: a text part, no functionCall part. */
function scriptedTextOnlyGenai(text: string | undefined): GoogleGenAI {
  return {
    models: {
      generateContent: async () => ({ candidates: [{ content: { parts: text === undefined ? [] : [{ text }] } }] }),
    },
  } as unknown as GoogleGenAI;
}

const capabilities: DiscoveredCapability[] = [
  {
    id: "open-sub-account",
    description: "Opens a new sub-account for a member.",
    inputParams: [
      { name: "memberId", type: "string", required: true },
      { name: "initialDeposit", type: "string", required: true },
    ],
  },
];

describe("buildToolDeclarations", () => {
  it("never marks a sensitive param as required, even when the capability itself requires it -- a credential field going into the JSON-schema `required` list all but guarantees the model invents a placeholder value to satisfy the contract", () => {
    const withCreds: DiscoveredCapability[] = [
      {
        id: "open-sub-account",
        description: "d",
        inputParams: [
          { name: "username", type: "string", required: true, sensitive: false },
          { name: "password", type: "string", required: true, sensitive: true },
          { name: "memberId", type: "string", required: true },
        ],
      },
    ];
    const [decl] = buildToolDeclarations(withCreds);
    const required = decl!.parameters!.required as string[];
    expect(required).toContain("username");
    expect(required).toContain("memberId");
    expect(required).not.toContain("password");
  });

  it("adds an explicit never-invent-a-value warning to a sensitive param's description", () => {
    const withCreds: DiscoveredCapability[] = [
      { id: "x", description: "d", inputParams: [{ name: "password", type: "string", required: true, sensitive: true }] },
    ];
    const [decl] = buildToolDeclarations(withCreds);
    const props = decl!.parameters!.properties as Record<string, { description?: string }>;
    expect(props.password?.description).toMatch(/never invent/i);
  });
});

/** Captures every `generateContent` call's `contents` so a test can assert what conversation
 *  history actually reached the model, not just what came back. */
function capturingGenai(name: string, args: Record<string, unknown>): { genai: GoogleGenAI; calls: unknown[] } {
  const calls: unknown[] = [];
  const genai = {
    models: {
      generateContent: async (req: { contents: unknown }) => {
        calls.push(req.contents);
        return { candidates: [{ content: { parts: [{ functionCall: { name, args, id: "call-1" } }] } }] };
      },
    },
  } as unknown as GoogleGenAI;
  return { genai, calls };
}

describe("planInvocation", () => {
  it("maps a scripted function call back to the capability id and extracts params/reasoning/tenantId", async () => {
    const genai = scriptedGenai("invoke__open_sub_account", {
      reasoning: "The request asks to open a sub-account for member 10001.",
      memberId: "10001",
      initialDeposit: "100",
      tenantId: "northgate-cu",
    });

    const result = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open a savings account for member 10001 with $100 at northgate");

    expect(result.kind).toBe("invoke");
    if (result.kind !== "invoke") throw new Error("expected invoke");
    expect(result.plan.capabilityId).toBe("open-sub-account");
    expect(result.plan.params).toEqual({ memberId: "10001", initialDeposit: "100" });
    expect(result.plan.tenantId).toBe("northgate-cu");
    expect(result.plan.reasoning).toContain("10001");
  });

  it("omits tenantId when the model doesn't supply one", async () => {
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });
    const result = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open an account for member 10001");
    if (result.kind !== "invoke") throw new Error("expected invoke");
    expect(result.plan.tenantId).toBeUndefined();
  });

  it("coerces non-string arg values (e.g. a number) to strings for the invoke API's param contract", async () => {
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: 100 });
    const result = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open an account for member 10001 with 100");
    if (result.kind !== "invoke") throw new Error("expected invoke");
    expect(result.plan.params.initialDeposit).toBe("100");
    expect(typeof result.plan.params.initialDeposit).toBe("string");
  });

  it("throws when there are no capabilities to plan against", async () => {
    const genai = scriptedGenai("anything", {});
    await expect(planInvocation(genai, ["gemini-3.7-flash"], [], "do something")).rejects.toThrow(/no capabilities/i);
  });

  it("throws when the model calls a function name that doesn't map to any known capability", async () => {
    const genai = scriptedGenai("invoke__totally_unknown", { reasoning: "r" });
    await expect(planInvocation(genai, ["gemini-3.7-flash"], capabilities, "do something")).rejects.toThrow(/unknown function/i);
  });

  describe("no function call (AUTO mode's real 'nothing matched' outcome)", () => {
    it("returns a clarify result with the model's own text reply, not an error, and never touches any capability", async () => {
      const genai = scriptedTextOnlyGenai("Hi! I can help you look up a member or open a new sub-account.");
      const result = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "hi");
      expect(result).toEqual({ kind: "clarify", message: "Hi! I can help you look up a member or open a new sub-account." });
    });

    it("falls back to a generic clarifying message if the model's response has no text part at all", async () => {
      const genai = scriptedTextOnlyGenai(undefined);
      const result = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "hi");
      expect(result.kind).toBe("clarify");
      if (result.kind !== "clarify") throw new Error("expected clarify");
      expect(result.message.length).toBeGreaterThan(0);
    });

    it("regression: a bare greeting must never be treated as an invocation of any capability -- this is the exact real incident (\"hi\" became a new member's name) this test guards against", async () => {
      const genai = scriptedTextOnlyGenai("Hi there! How can I help?");
      const result = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "hi");
      expect(result.kind).not.toBe("invoke");
    });
  });

  describe("history (regression: multi-turn slot-filling silently lost context without this)", () => {
    it("with no history, sends only the current utterance as the sole content", async () => {
      const { genai, calls } = capturingGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });
      await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open an account for member 10001");
      expect(calls[0]).toEqual([{ role: "user", parts: [{ text: "open an account for member 10001" }] }]);
    });

    it("prepends prior turns (oldest first) before the current utterance, in Gemini's role/parts shape", async () => {
      const { genai, calls } = capturingGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });
      await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "with $100", [
        { role: "user", text: "I want to open an account for member 10001" },
        { role: "model", text: "How much would you like to deposit?" },
      ]);

      expect(calls[0]).toEqual([
        { role: "user", parts: [{ text: "I want to open an account for member 10001" }] },
        { role: "model", parts: [{ text: "How much would you like to deposit?" }] },
        { role: "user", parts: [{ text: "with $100" }] },
      ]);
    });
  });
});
