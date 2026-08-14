import { describe, expect, it } from "vitest";
import { DiscoveryAgent } from "./discovery-agent.js";
import type { Action, ActionResult, PredictedNavigation, StateSnapshot, Surface } from "../surface/types.js";
import type { GuardrailsPolicy, AuthorizationResult } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";

/**
 * The discovery loop's control flow (escalate/resume, dead-end detection, risky-action
 * confirmation) is near-pure orchestration logic sitting on top of three collaborators
 * (Surface, GuardrailsPolicy, the Gemini client) -- exactly the kind of thing the replay
 * engine's own tests already fake out. What's deliberately NOT faked anywhere in this repo
 * is the model's *judgment* (what real Gemini decides to click) or a real browser; here we
 * fake the model's *output* with a fixed script of tool calls, which tests the loop's
 * mechanics (does resume actually continue the loop? does dead-end detection actually
 * fire?) without claiming to test what Gemini would really decide.
 */

function functionCallResponse(name: string, args: Record<string, unknown>, id = "call-1") {
  return { candidates: [{ content: { parts: [{ functionCall: { name, args, id } }] } }] };
}

function scriptedGenai(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  let i = 0;
  return {
    models: {
      generateContent: async () => {
        const call = calls[Math.min(i, calls.length - 1)];
        i += 1;
        return functionCallResponse(call.name, call.args, `call-${i}`);
      },
    },
  } as unknown as ConstructorParameters<typeof DiscoveryAgent>[0]["genai"];
}

function fakeSurface(elements: StateSnapshot["elements"] = []): Surface {
  return {
    observe: async (): Promise<StateSnapshot> => ({ url: "http://x/page", title: "Page", elements, screenshotPath: "s.png" }),
    perform: async (action: Action): Promise<ActionResult> => ({ ok: true, url: "http://x/page" }),
    predictNavigation: async (): Promise<PredictedNavigation | null> => null,
    getVisibleText: async () => "",
    screenshot: async (label: string) => `screenshot-${label}.png`,
    currentUrl: () => "http://x/page",
    close: async () => undefined,
  };
}

function fakePolicy(overrides: { authorize?: (surface: Surface, action: Action) => Promise<AuthorizationResult> } = {}): GuardrailsPolicy {
  return {
    authorize: overrides.authorize ?? (async () => ({ allowed: true, risk: "safe" as const })),
  } as unknown as GuardrailsPolicy;
}

function fakeLogger(): EvidenceLogger {
  return {
    log: () => undefined,
    addSensitiveKeys: () => undefined,
    addSensitiveValue: () => undefined,
    writeJson: () => "",
  } as unknown as EvidenceLogger;
}

describe("discovery agent: escalate -> resume -> finish", () => {
  it("continues the loop and finishes after onEscalate returns resume", async () => {
    const genai = scriptedGenai([
      { name: "escalate", args: { reason: "blocked, need a human" } },
      { name: "finish", args: { success: true, summary: "done after resume" } },
    ]);
    let escalateCalls = 0;
    const agent = new DiscoveryAgent({
      surface: fakeSurface(),
      policy: fakePolicy(),
      logger: fakeLogger(),
      genai,
      onEscalate: async () => {
        escalateCalls += 1;
        return "resume";
      },
    });

    const result = await agent.run("goal", "http://x/start");

    expect(escalateCalls).toBe(1);
    expect(result.status).toBe("finished");
    expect(result.finalSummary).toBe("done after resume");
  });

  it("stops with status escalated when onEscalate returns abort", async () => {
    const genai = scriptedGenai([{ name: "escalate", args: { reason: "blocked" } }]);
    const agent = new DiscoveryAgent({
      surface: fakeSurface(),
      policy: fakePolicy(),
      logger: fakeLogger(),
      genai,
      onEscalate: async () => "abort",
    });

    const result = await agent.run("goal", "http://x/start");

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toBe("blocked");
  });

  it("defaults to abort when no onEscalate handler is provided", async () => {
    const genai = scriptedGenai([{ name: "escalate", args: { reason: "blocked" } }]);
    const agent = new DiscoveryAgent({ surface: fakeSurface(), policy: fakePolicy(), logger: fakeLogger(), genai });

    const result = await agent.run("goal", "http://x/start");

    expect(result.status).toBe("escalated");
  });
});

describe("discovery agent: risky action confirmation", () => {
  it("performs the action when a risky click is approved", async () => {
    const elements: StateSnapshot["elements"] = [
      { role: "button", name: "Submit", nth: 0, locatorCandidates: [{ strategy: "text", name: "Submit", nth: 0, confidence: "medium", rationale: "r" }] },
    ];
    const genai = scriptedGenai([
      { name: "click", args: { role: "button", name: "Submit" } },
      { name: "finish", args: { success: true, summary: "done" } },
    ]);
    let riskyAsked = 0;
    const agent = new DiscoveryAgent({
      surface: fakeSurface(elements),
      policy: fakePolicy({ authorize: async () => ({ allowed: true, risk: "risky", route: "/submit", method: "POST" }) }),
      logger: fakeLogger(),
      genai,
      onRiskyAction: async () => {
        riskyAsked += 1;
        return true;
      },
    });

    const result = await agent.run("goal", "http://x/start");

    expect(riskyAsked).toBe(1);
    expect(result.status).toBe("finished");
  });

  it("escalates without a resume option when a risky action is declined", async () => {
    const elements: StateSnapshot["elements"] = [
      { role: "button", name: "Submit", nth: 0, locatorCandidates: [{ strategy: "text", name: "Submit", nth: 0, confidence: "medium", rationale: "r" }] },
    ];
    const genai = scriptedGenai([{ name: "click", args: { role: "button", name: "Submit" } }]);
    const agent = new DiscoveryAgent({
      surface: fakeSurface(elements),
      policy: fakePolicy({ authorize: async () => ({ allowed: true, risk: "risky", route: "/submit", method: "POST" }) }),
      logger: fakeLogger(),
      genai,
      onRiskyAction: async () => false,
    });

    const result = await agent.run("goal", "http://x/start");

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toMatch(/requires confirmation/);
  });

  it("blocks and escalates when the guardrail policy denies the action outright", async () => {
    const elements: StateSnapshot["elements"] = [
      { role: "button", name: "Submit", nth: 0, locatorCandidates: [{ strategy: "text", name: "Submit", nth: 0, confidence: "medium", rationale: "r" }] },
    ];
    const genai = scriptedGenai([{ name: "click", args: { role: "button", name: "Submit" } }]);
    const agent = new DiscoveryAgent({
      surface: fakeSurface(elements),
      policy: fakePolicy({ authorize: async () => ({ allowed: false, risk: "risky", reason: "outside allowlist" }) }),
      logger: fakeLogger(),
      genai,
    });

    const result = await agent.run("goal", "http://x/start");

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toMatch(/outside allowlist/);
  });
});

describe("discovery agent: dead-end detection", () => {
  it("stops with status dead_end after repeating the same unresolvable action", async () => {
    const genai = scriptedGenai([{ name: "click", args: { role: "button", name: "Nonexistent" } }]);
    const agent = new DiscoveryAgent({ surface: fakeSurface([]), policy: fakePolicy(), logger: fakeLogger(), genai });

    const result = await agent.run("goal", "http://x/start");

    expect(result.status).toBe("dead_end");
    expect(result.escalationReason).toMatch(/Repeated the same failing action 3 times/);
  });

  it("does not count a repeated action toward the dead-end limit if reasoning text differs but the action itself is identical", async () => {
    const genai = scriptedGenai([
      { name: "click", args: { role: "button", name: "Nonexistent", reasoning: "attempt A" } },
      { name: "click", args: { role: "button", name: "Nonexistent", reasoning: "attempt B (different text)" } },
      { name: "click", args: { role: "button", name: "Nonexistent", reasoning: "attempt C (different again)" } },
    ]);
    const agent = new DiscoveryAgent({ surface: fakeSurface([]), policy: fakePolicy(), logger: fakeLogger(), genai });

    const result = await agent.run("goal", "http://x/start");

    // Still a dead end after 3 attempts -- the point is that varying free-text `reasoning`
    // (which real Gemini calls always vary slightly) must not reset the repeat counter.
    expect(result.status).toBe("dead_end");
  });
});
