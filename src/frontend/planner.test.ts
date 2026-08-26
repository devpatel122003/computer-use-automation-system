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

describe("planInvocation", () => {
  it("maps a scripted function call back to the capability id and extracts params/reasoning/tenantId", async () => {
    const genai = scriptedGenai("invoke__open_sub_account", {
      reasoning: "The request asks to open a sub-account for member 10001.",
      memberId: "10001",
      initialDeposit: "100",
      tenantId: "northgate-cu",
    });

    const plan = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open a savings account for member 10001 with $100 at northgate");

    expect(plan.capabilityId).toBe("open-sub-account");
    expect(plan.params).toEqual({ memberId: "10001", initialDeposit: "100" });
    expect(plan.tenantId).toBe("northgate-cu");
    expect(plan.reasoning).toContain("10001");
  });

  it("omits tenantId when the model doesn't supply one", async () => {
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: "100" });
    const plan = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open an account for member 10001");
    expect(plan.tenantId).toBeUndefined();
  });

  it("coerces non-string arg values (e.g. a number) to strings for the invoke API's param contract", async () => {
    const genai = scriptedGenai("invoke__open_sub_account", { reasoning: "r", memberId: "10001", initialDeposit: 100 });
    const plan = await planInvocation(genai, ["gemini-3.7-flash"], capabilities, "open an account for member 10001 with 100");
    expect(plan.params.initialDeposit).toBe("100");
    expect(typeof plan.params.initialDeposit).toBe("string");
  });

  it("throws when there are no capabilities to plan against", async () => {
    const genai = scriptedGenai("anything", {});
    await expect(planInvocation(genai, ["gemini-3.7-flash"], [], "do something")).rejects.toThrow(/no capabilities/i);
  });

  it("throws when the model calls a function name that doesn't map to any known capability", async () => {
    const genai = scriptedGenai("invoke__totally_unknown", { reasoning: "r" });
    await expect(planInvocation(genai, ["gemini-3.7-flash"], capabilities, "do something")).rejects.toThrow(/unknown function/i);
  });
});
