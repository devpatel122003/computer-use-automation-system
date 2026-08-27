import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attemptAssistedRecovery } from "./assisted-recovery.js";
import type { ArtifactStep } from "../artifact/schema.js";
import type { Action, ActionResult, PredictedNavigation, StateSnapshot, Surface } from "../surface/types.js";
import type { AuthorizationResult, GuardrailsPolicy } from "../guardrails/policy.js";
import { fakeLogger } from "../test-support/fixtures.js";
import type { GoogleGenAI } from "@google/genai";

/** attemptAssistedRecovery reads the screenshot path's bytes for real (to send as an
 *  inline image part), so the fake surface below needs to return a real file, not a
 *  made-up string. Content doesn't matter for these tests -- nothing here asserts what
 *  image bytes the (scripted) model receives. */
function writeFakeScreenshot(): string {
  const file = path.join(os.tmpdir(), `assisted-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(file, "not a real png, just needs to exist");
  return file;
}

/** Same discipline as discovery-agent.test.ts/planner.test.ts: fake the model's *output*
 *  with a scripted function call, not its judgment. */
function scriptedGenai(name: string | undefined, args: Record<string, unknown> = {}): GoogleGenAI {
  return {
    models: {
      generateContent: async () =>
        name ? { candidates: [{ content: { parts: [{ functionCall: { name, args, id: "call-1" } }] } }] } : { candidates: [{ content: { parts: [] } }] },
    },
  } as unknown as GoogleGenAI;
}

function step(): ArtifactStep {
  return {
    id: "step-6",
    actionType: "click",
    description: 'Click button "Look Up Member"',
    risk: "safe",
    waitPolicy: { timeoutMs: 5000, retries: 0 },
  };
}

function fakeSurface(elements: StateSnapshot["elements"], performImpl: (action: Action) => Promise<ActionResult>): Surface {
  return {
    observe: async (): Promise<StateSnapshot> => ({ url: "http://x/page", title: "Page", elements, screenshotPath: "s.png" }),
    perform: performImpl,
    predictNavigation: async (): Promise<PredictedNavigation | null> => null,
    getVisibleText: async () => "",
    screenshot: async () => writeFakeScreenshot(),
    currentUrl: () => "http://x/page",
    close: async () => undefined,
  };
}

function fakePolicy(authorize?: (surface: Surface, action: Action) => Promise<AuthorizationResult>): GuardrailsPolicy {
  return {
    authorize: authorize ?? (async () => ({ allowed: true, risk: "safe" as const })),
    authorizeLandedUrl: () => ({ allowed: true, risk: "safe" as const }),
  } as unknown as GuardrailsPolicy;
}

const element = {
  role: "button" as const,
  name: "Search",
  nth: 0,
  locatorCandidates: [{ strategy: "role" as const, role: "button" as const, name: "Search", nth: 0, confidence: "high" as const, rationale: "r" }],
};

describe("attemptAssistedRecovery", () => {
  it("executes the model's proposed action and reports recovered:true when it succeeds", async () => {
    const genai = scriptedGenai("click", { reasoning: "The button is now labeled Search instead of Look Up Member.", role: "button", name: "Search" });
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy: fakePolicy(), logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "no element resolved",
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.reasoning).toContain("Search");
  });

  it("reports recovered:false when the proposed element doesn't resolve on the current page", async () => {
    const genai = scriptedGenai("click", { reasoning: "r", role: "button", name: "Nonexistent" });
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy: fakePolicy(), logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x",
    });
    expect(outcome.recovered).toBe(false);
    expect(outcome.note).toMatch(/no element found/i);
  });

  it("declines a risky proposal by default when no onRiskyStep callback is wired up (e.g. the unattended capability API)", async () => {
    const genai = scriptedGenai("click", { reasoning: "r", role: "button", name: "Search" });
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const policy = fakePolicy(async () => ({ allowed: true, risk: "risky" as const }));
    const outcome = await attemptAssistedRecovery({ config: { genai }, surface, policy, logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x" });
    expect(outcome.recovered).toBe(false);
    expect(outcome.note).toMatch(/risky and was not confirmed/i);
  });

  it("declines a risky proposal when onRiskyStep is asked and returns false", async () => {
    const genai = scriptedGenai("click", { reasoning: "r", role: "button", name: "Search" });
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const policy = fakePolicy(async () => ({ allowed: true, risk: "risky" as const }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy, logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x", onRiskyStep: async () => false,
    });
    expect(outcome.recovered).toBe(false);
  });

  it("executes a risky proposal once onRiskyStep confirms it -- same contract as a normal risky step, not a blanket refusal", async () => {
    const genai = scriptedGenai("click", { reasoning: "r", role: "button", name: "Search" });
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const policy = fakePolicy(async () => ({ allowed: true, risk: "risky" as const }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy, logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x", onRiskyStep: async () => true,
    });
    expect(outcome.recovered).toBe(true);
  });

  it("proposes click_at_coordinates when the model uses the vision fallback tool, and executes it once confirmed (coordinate clicks are always classified risky)", async () => {
    const genai = scriptedGenai("click_at_coordinates", { reasoning: "A canvas-drawn button is visible there.", x: 120, y: 340 });
    const surface = fakeSurface([], async (action) => {
      expect(action).toEqual({ type: "click_coordinates", x: 120, y: 340 });
      return { ok: true, url: "http://x/page" };
    });
    const policy = fakePolicy(async (_surface, action) => {
      expect(action.type).toBe("click_coordinates");
      return { allowed: true, risk: "risky" as const };
    });
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy, logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "no DOM element for this canvas widget", onRiskyStep: async () => true,
    });
    expect(outcome.recovered).toBe(true);
  });

  it("refuses to execute a proposed action the guardrail policy blocks outright", async () => {
    const genai = scriptedGenai("click", { reasoning: "r", role: "button", name: "Search" });
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const policy = fakePolicy(async () => ({ allowed: false, risk: "risky" as const, reason: "not in allowlist" }));
    const outcome = await attemptAssistedRecovery({ config: { genai }, surface, policy, logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x" });
    expect(outcome.recovered).toBe(false);
  });

  it("reports recovered:false when the model returns no function call at all", async () => {
    const genai = scriptedGenai(undefined);
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy: fakePolicy(), logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x",
    });
    expect(outcome.recovered).toBe(false);
    expect(outcome.note).toMatch(/no function call/i);
  });

  it("degrades gracefully (recovered:false, no throw) when the model call itself fails -- a transient API error must never be worse than not having assisted recovery at all", async () => {
    const genai = {
      models: { generateContent: async () => { throw new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'); } },
    } as unknown as GoogleGenAI;
    const surface = fakeSurface([element], async () => ({ ok: true, url: "http://x/page" }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy: fakePolicy(), logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x",
    });
    expect(outcome.recovered).toBe(false);
    expect(outcome.note).toMatch(/model call failed/i);
  });

  it("reports recovered:false when the action resolves and is authorized but still fails to execute", async () => {
    const genai = scriptedGenai("click", { reasoning: "r", role: "button", name: "Search" });
    const surface = fakeSurface([element], async () => ({ ok: false, error: "timeout", url: "http://x/page" }));
    const outcome = await attemptAssistedRecovery({
      config: { genai }, surface, policy: fakePolicy(), logger: fakeLogger(), step: step(), stepNum: 6, failureContext: "x",
    });
    expect(outcome.recovered).toBe(false);
    expect(outcome.note).toBe("timeout");
  });
});
