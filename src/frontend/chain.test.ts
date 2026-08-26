import { afterEach, describe, expect, it, vi } from "vitest";
import { splitChainedUtterance, planChainedTurn } from "./chain.js";
import type { GoogleGenAI } from "@google/genai";

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
];

/** Routes a scripted response by inspecting the last user turn's text -- needed because
 *  planChainedTurn calls planChatTurn twice, once per clause, and each clause must resolve
 *  to a DIFFERENT capability for a realistic chained scenario. */
function routedGenai(router: (utterance: string) => { name: string; args: Record<string, unknown> } | { text: string }): GoogleGenAI {
  return {
    models: {
      generateContent: async (req: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
        const utterance = req.contents[req.contents.length - 1]?.parts?.[0]?.text ?? "";
        const result = router(utterance);
        if ("text" in result) return { candidates: [{ content: { parts: [{ text: result.text }] } }] };
        return { candidates: [{ content: { parts: [{ functionCall: { name: result.name, args: result.args, id: "call-1" } }] } }] };
      },
    },
  } as unknown as GoogleGenAI;
}

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify(CATALOG), { status: 200 });
    return new Response(JSON.stringify({ status: "success", outputs: {} }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitChainedUtterance", () => {
  it("splits the canonical demo sentence on a comma + 'then'", () => {
    expect(splitChainedUtterance("create a new member named Dave, then open a savings account for them with $100")).toEqual({
      first: "create a new member named Dave",
      second: "open a savings account for them with $100",
    });
  });

  it("splits on 'and then' with no comma", () => {
    expect(splitChainedUtterance("create a member named Dave and then open an account for them")).toEqual({
      first: "create a member named Dave",
      second: "open an account for them",
    });
  });

  it("splits on 'after that'", () => {
    expect(splitChainedUtterance("create a member named Dave, after that open an account")).toEqual({
      first: "create a member named Dave",
      second: "open an account",
    });
  });

  it("returns null when there's no connector at all", () => {
    expect(splitChainedUtterance("open a savings account for member 10001 with $100")).toBeNull();
  });

  it("returns null when the second clause is empty (nothing after the connector)", () => {
    expect(splitChainedUtterance("create a member named Dave, then")).toBeNull();
  });

  it("returns null when the first clause is empty (connector at the very start)", () => {
    expect(splitChainedUtterance("then open an account")).toBeNull();
  });
});

describe("planChainedTurn", () => {
  it("returns not-chain when the message has no connector", async () => {
    stubFetch();
    const genai = routedGenai(() => ({ text: "unused" }));
    const result = await planChainedTurn({ genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k" }, "check my balance for member 10001");
    expect(result.kind).toBe("not-chain");
  });

  it("returns not-chain when either clause comes back clarified", async () => {
    stubFetch();
    const genai = routedGenai((utterance) =>
      utterance.includes("Dave") ? { name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } } : { text: "I don't understand." }
    );
    const result = await planChainedTurn(
      { genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k" },
      "create a member named Dave, then do something unclear"
    );
    expect(result.kind).toBe("not-chain");
  });

  it("returns not-chain when the two chosen capabilities have no row in CHAIN_MAPPINGS", async () => {
    stubFetch();
    const genai = routedGenai((utterance) =>
      utterance.includes("balance")
        ? { name: "invoke__check_balance", args: { reasoning: "r", memberId: "10001" } }
        : { name: "invoke__open_sub_account", args: { reasoning: "r", memberId: "10001", accountType: "Savings", initialDeposit: "100" } }
    );
    // open-sub-account -> check-balance is not a mapped pair (only create-member is a
    // "from" capability in CHAIN_MAPPINGS).
    const result = await planChainedTurn(
      { genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k" },
      "open an account for member 10001 with $100 savings, then check my balance"
    );
    expect(result.kind).toBe("not-chain");
  });

  it("returns a chained result with both plans and the correct mapping for the canonical example", async () => {
    stubFetch();
    const genai = routedGenai((utterance) =>
      utterance.includes("Dave")
        ? { name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } }
        : { name: "invoke__open_sub_account", args: { reasoning: "r", accountType: "Savings", initialDeposit: "100" } }
    );
    const result = await planChainedTurn(
      { genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k" },
      "create a new member named Dave, then open a savings account for them with $100"
    );

    expect(result.kind).toBe("chained");
    if (result.kind !== "chained") throw new Error("expected chained");
    expect(result.step1.plan.capabilityId).toBe("create-member");
    expect(result.step2.plan.capabilityId).toBe("open-sub-account");
    expect(result.mapping).toEqual({ fromCapabilityId: "create-member", fromField: "newMemberId", toCapabilityId: "open-sub-account", toField: "memberId" });
  });

  it("regression: the second clause's planning call includes a placeholder member-id hint, since a real Gemini call planning it in complete isolation (no concrete member reference at all) correctly refused to call ANY function rather than invoke one with the field omitted", async () => {
    const genai = routedGenai((utterance) => {
      if (utterance.includes("Dave")) return { name: "invoke__create_member", args: { reasoning: "r", fullName: "Dave" } };
      // Simulates the real behavior this regression guards against: without the hint text
      // actually reaching this call, treat it as too unclear to invoke anything.
      if (!utterance.includes("CHAIN-STEP-1-MEMBER-ID")) return { text: "I need a member ID to proceed." };
      return { name: "invoke__open_sub_account", args: { reasoning: "r", accountType: "Savings", initialDeposit: "100" } };
    });
    stubFetch();

    const result = await planChainedTurn(
      { genai, models: ["m"], apiBase: "http://localhost:4700", apiKey: "k" },
      "create a new member named Dave, then open a savings account for them with $100"
    );

    expect(result.kind).toBe("chained");
  });
});
