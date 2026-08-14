import { describe, expect, it, vi } from "vitest";
import { replay } from "./replay-engine.js";
import type { CapabilityArtifact, ArtifactStep, LocatorCandidate } from "../artifact/schema.js";
import type { Action, ActionResult, PredictedNavigation, StateSnapshot, Surface } from "../surface/types.js";
import type { GuardrailsPolicy, AuthorizationResult } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";

function locator(name: string): LocatorCandidate[] {
  return [{ strategy: "text", name, nth: 0, confidence: "medium", rationale: "test fixture" }];
}

function step(overrides: Partial<ArtifactStep> & Pick<ArtifactStep, "id" | "actionType">): ArtifactStep {
  return { description: overrides.id, risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 }, ...overrides };
}

function makeArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return {
    id: "test-capability",
    name: "Test",
    description: "d",
    version: "1.0.0",
    createdAt: "2026-01-01T00:00:00.000Z",
    target: { appId: "mock", surfaceType: "web", baseUrlPattern: "http://x" },
    inputParams: [],
    outputSchema: [],
    steps: [],
    successCheckpoint: { kind: "text_match", expr: "done", description: "done" },
    knownOutcomes: [],
    ...overrides,
  };
}

/** State-carrying fake Surface: perform() is fully test-controlled via a per-test impl
 *  closure that reads/writes `state`, since executeStep's control flow (recovery, landed-
 *  URL checks, checkpoint re-evaluation) all depend on currentUrl()/getVisibleText()
 *  reflecting whatever perform() "did". */
function fakeSurface(state: { url: string; text: string }, performImpl: (action: Action) => Promise<ActionResult>): Surface {
  return {
    observe: async (): Promise<StateSnapshot> => {
      throw new Error("not used in these tests");
    },
    perform: performImpl,
    predictNavigation: async (_action: Action): Promise<PredictedNavigation | null> => null,
    getVisibleText: async () => state.text,
    screenshot: async (label: string) => `screenshot-${label}.png`,
    currentUrl: () => state.url,
    close: async () => undefined,
  };
}

function fakePolicy(overrides: {
  authorize?: (surface: Surface, action: Action) => Promise<AuthorizationResult>;
  authorizeLandedUrl?: (url: string) => AuthorizationResult;
} = {}): { policy: GuardrailsPolicy; authorizeCalls: Action[] } {
  const authorizeCalls: Action[] = [];
  const policy = {
    authorize: async (surface: Surface, action: Action) => {
      authorizeCalls.push(action);
      return overrides.authorize ? overrides.authorize(surface, action) : { allowed: true, risk: "safe" as const };
    },
    authorizeLandedUrl: overrides.authorizeLandedUrl ?? (() => ({ allowed: true, risk: "safe" as const })),
  } as unknown as GuardrailsPolicy;
  return { policy, authorizeCalls };
}

function fakeLogger(): EvidenceLogger {
  return {
    log: () => undefined,
    addSensitiveKeys: () => undefined,
    addSensitiveValue: () => undefined,
    writeJson: () => "",
  } as unknown as EvidenceLogger;
}

describe("replay: happy path", () => {
  it("succeeds when every step and the final checkpoint pass", async () => {
    const state = { url: "http://x/start", text: "" };
    const artifact = makeArtifact({
      steps: [
        step({ id: "step-1", actionType: "navigate", url: "/start" }),
        step({ id: "step-2", actionType: "click", locator: locator("Continue"), checkpoint: { kind: "url", expr: "/done", description: "reached done" } }),
      ],
      successCheckpoint: { kind: "text_match", expr: "all set", description: "final banner" },
    });

    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async (action) => {
      if (action.type === "navigate") {
        state.url = action.url;
        return { ok: true, url: state.url };
      }
      state.url = "http://x/done";
      state.text = "all set";
      return { ok: true, url: state.url };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });
    expect(result.status).toBe("success");
  });
});

describe("replay: C3 -- recovery must not bypass guardrails", () => {
  it("routes recovery step actions and the post-recovery retry through policy.authorize()", async () => {
    const state = { url: "http://x/login", text: "" };
    let clickCount = 0;

    const artifact = makeArtifact({
      steps: [
        step({ id: "step-1", actionType: "navigate", url: "/login" }),
        step({
          id: "step-2",
          actionType: "click",
          locator: locator("Continue"),
          checkpoint: { kind: "url", expr: "/target", description: "reached target" },
        }),
      ],
      knownOutcomes: [
        {
          name: "session_timeout",
          category: "recoverable",
          detector: { kind: "text_match", expr: "expired", description: "" },
          description: "session expired",
          recovery: "reauthenticate_and_retry_step",
          recoveryStepIds: ["step-1"],
        },
      ],
      successCheckpoint: { kind: "text_match", expr: "all set", description: "" },
    });

    const { policy, authorizeCalls } = fakePolicy();
    const surface = fakeSurface(state, async (action) => {
      if (action.type === "navigate") {
        state.url = "http://x/login";
        state.text = "";
        return { ok: true, url: state.url };
      }
      // click: first attempt lands on an "expired" page (checkpoint will fail), second
      // attempt (after recovery re-runs step-1) lands correctly.
      clickCount += 1;
      if (clickCount === 1) {
        state.url = "http://x/expired";
        state.text = "your session has expired";
      } else {
        state.url = "http://x/target";
        state.text = "all set";
      }
      return { ok: true, url: state.url };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });

    expect(result.status).toBe("success");
    // step-1 (initial) + step-2 (initial) + step-1 (recovery re-run) + step-2 (post-recovery
    // retry) = 4 authorize() calls. Previously recovery and the retry both called
    // surface.perform() directly, so this would have been 2, not 4.
    expect(authorizeCalls).toHaveLength(4);
  });

  it("does not re-fire a risky action unattended on the post-recovery retry without re-confirmation", async () => {
    const state = { url: "http://x/login", text: "" };
    let clickCount = 0;
    const onRiskyStep = vi.fn(async () => true);

    const artifact = makeArtifact({
      steps: [
        step({ id: "step-1", actionType: "navigate", url: "/login" }),
        step({
          id: "step-2",
          actionType: "click",
          locator: locator("Submit"),
          risk: "risky",
          checkpoint: { kind: "url", expr: "/target", description: "" },
        }),
      ],
      knownOutcomes: [
        {
          name: "session_timeout",
          category: "recoverable",
          detector: { kind: "text_match", expr: "expired", description: "" },
          description: "session expired",
          recovery: "reauthenticate_and_retry_step",
          recoveryStepIds: ["step-1"],
        },
      ],
      successCheckpoint: { kind: "text_match", expr: "all set", description: "" },
    });

    const { policy } = fakePolicy({
      authorize: async (_s, action) => {
        if (action.type === "click") return { allowed: true, risk: "risky" };
        return { allowed: true, risk: "safe" };
      },
    });
    const surface = fakeSurface(state, async (action) => {
      if (action.type === "navigate") return { ok: true, url: state.url };
      clickCount += 1;
      if (clickCount === 1) {
        state.url = "http://x/expired";
        state.text = "your session has expired";
      } else {
        state.url = "http://x/target";
        state.text = "all set";
      }
      return { ok: true, url: state.url };
    });

    // allowRisky is FALSE -- every risky execution must go through onRiskyStep, including
    // the post-recovery retry of the same risky click.
    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: false, onRiskyStep });

    expect(result.status).toBe("success");
    expect(onRiskyStep).toHaveBeenCalledTimes(2); // initial attempt + post-recovery retry
  });
});

describe("replay: M1 -- post-recovery retry re-verifies, not just re-runs", () => {
  it("reports a checkpoint failure if the post-recovery retry lands somewhere still wrong", async () => {
    const state = { url: "http://x/login", text: "" };

    const artifact = makeArtifact({
      steps: [
        step({ id: "step-1", actionType: "navigate", url: "/login" }),
        step({
          id: "step-2",
          actionType: "click",
          locator: locator("Continue"),
          checkpoint: { kind: "url", expr: "/target", description: "reached target" },
        }),
      ],
      knownOutcomes: [
        {
          name: "session_timeout",
          category: "recoverable",
          detector: { kind: "text_match", expr: "expired", description: "" },
          description: "session expired",
          recovery: "reauthenticate_and_retry_step",
          recoveryStepIds: ["step-1"],
        },
      ],
    });

    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async (action) => {
      if (action.type === "navigate") {
        state.url = "http://x/login";
        state.text = "";
        return { ok: true, url: state.url };
      }
      // The click ALWAYS lands on the wrong page, even after recovery -- recovery
      // "succeeded" (the re-login itself worked) but the underlying problem didn't clear.
      state.url = "http://x/still-wrong";
      state.text = "your session has expired";
      return { ok: true, url: state.url };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });

    // Must NOT silently report success just because recovery ran once -- the checkpoint
    // genuinely never passed, and there's a recovery-attempt cap (1) so it must not loop
    // forever either.
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.stepId).toBe("step-2");
    }
  });

  it("captures an extract step's output on the post-recovery retry, not the failed first attempt", async () => {
    const state = { url: "http://x/login", text: "" };
    let extractCount = 0;

    const artifact = makeArtifact({
      steps: [
        step({ id: "step-1", actionType: "navigate", url: "/login" }),
        step({ id: "step-2", actionType: "extract", locator: locator("Balance"), outputName: "balance" }),
      ],
      outputSchema: [{ name: "balance", type: "string", sourceStepId: "step-2" }],
      knownOutcomes: [
        {
          name: "session_timeout",
          category: "recoverable",
          detector: { kind: "text_match", expr: "expired", description: "" },
          description: "session expired",
          recovery: "reauthenticate_and_retry_step",
          recoveryStepIds: ["step-1"],
        },
      ],
      successCheckpoint: { kind: "text_match", expr: "ok", description: "" },
    });

    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async (action) => {
      if (action.type === "navigate") {
        state.text = "ok";
        return { ok: true, url: state.url };
      }
      extractCount += 1;
      if (extractCount === 1) {
        // First extract fails because the session expired underneath it -- the page now
        // shows the expiry banner, which is what detectKnownOutcome should key off of.
        state.text = "your session has expired";
        return { ok: false, error: "detached", url: state.url };
      }
      state.text = "ok";
      return { ok: true, url: state.url, extractedValue: "$500.00" };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.balance).toBe("$500.00");
    }
  });
});

describe("replay: M8 -- landed URL is re-checked against the allowlist", () => {
  it("fails the step if the action lands somewhere outside the allowlist, even if predicted OK", async () => {
    const state = { url: "http://x/start", text: "" };
    const artifact = makeArtifact({
      steps: [step({ id: "step-1", actionType: "navigate", url: "/start" })],
    });

    const { policy } = fakePolicy({
      authorizeLandedUrl: (url) => (url === "http://evil/start" ? { allowed: false, reason: "off-allowlist", risk: "risky" } : { allowed: true, risk: "safe" }),
    });
    const surface = fakeSurface(state, async (action) => {
      if (action.type === "navigate") {
        // Simulate a redirect landing somewhere the pre-flight check never saw.
        state.url = "http://evil/start";
        return { ok: true, url: state.url };
      }
      return { ok: true, url: state.url };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.observed).toContain("off-allowlist");
    }
  });

  it("does not falsely block a POST-only route re-rendered in place (no redirect)", async () => {
    // Regression: using the REAL GuardrailsPolicy (not a fake) against a route that's only
    // allowlisted for POST. A server can respond to a POST by re-rendering the same page at
    // the same URL instead of redirecting (e.g. this app's validation-error page), so the
    // browser's location after a successful POST is still that POST-only URL. The landed-
    // URL check must not assume every landing was reached via GET.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const { GuardrailsPolicy } = await import("../guardrails/policy.js");

    const configPath = pathMod.join(os.tmpdir(), `allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        allowedBaseUrls: ["http://x"],
        routes: [{ pattern: "/sub-accounts", methods: ["POST"], risk: "risky" }],
      })
    );
    const realPolicy = new GuardrailsPolicy(configPath);

    const state = { url: "http://x/form", text: "" };
    const artifact = makeArtifact({
      steps: [step({ id: "step-1", actionType: "click", locator: locator("Submit"), risk: "risky" })],
      successCheckpoint: { kind: "text_match", expr: "done", description: "" },
    });
    const surface = fakeSurface(state, async () => {
      // The POST "succeeds" but the server re-renders in place rather than redirecting.
      state.url = "http://x/sub-accounts";
      state.text = "done";
      return { ok: true, url: state.url };
    });
    // predictNavigation isn't consulted by the real policy here since fakeSurface's default
    // returns null/undefined; force a POST prediction so the pre-flight check passes.
    surface.predictNavigation = async () => ({ url: "http://x/sub-accounts", method: "POST" });

    const result = await replay({ artifact, params: {}, surface, policy: realPolicy, logger: fakeLogger(), runId: "r1", allowRisky: true });
    expect(result.status).toBe("success");
  });
});

describe("replay: retry_step recovery", () => {
  it("retries the same step without re-running any prior steps", async () => {
    const state = { url: "http://x/page", text: "" };
    let clickCount = 0;

    const artifact = makeArtifact({
      steps: [step({ id: "step-1", actionType: "click", locator: locator("Load"), checkpoint: { kind: "text_match", expr: "loaded", description: "" } })],
      knownOutcomes: [
        {
          name: "transient_slow_load",
          category: "recoverable",
          detector: { kind: "text_match", expr: "still loading", description: "" },
          description: "transient",
          recovery: "retry_step",
        },
      ],
      successCheckpoint: { kind: "text_match", expr: "loaded", description: "" },
    });

    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async () => {
      clickCount += 1;
      state.text = clickCount === 1 ? "still loading" : "loaded";
      return { ok: true, url: state.url };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });
    expect(result.status).toBe("success");
    expect(clickCount).toBe(2);
  });
});

describe("replay: business outcomes", () => {
  it("reports a business_outcome (not a failure) and captures a screenshot", async () => {
    const state = { url: "http://x/search", text: "" };
    const artifact = makeArtifact({
      steps: [step({ id: "step-1", actionType: "click", locator: locator("Search"), checkpoint: { kind: "url", expr: "/members/1", description: "" } })],
      knownOutcomes: [
        { name: "member_not_found", category: "business_outcome", detector: { kind: "text_match", expr: "no member found", description: "" }, description: "not found" },
      ],
    });

    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async () => {
      state.url = "http://x/search";
      state.text = "No member found with ID 40404";
      return { ok: true, url: state.url };
    });

    const result = await replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1", allowRisky: true });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("member_not_found");
      expect(result.evidenceRef).toBeTruthy();
    }
  });
});

describe("replay: input param validation", () => {
  it("throws a clear error when a param declared type 'number' isn't numeric", async () => {
    const artifact = makeArtifact({
      inputParams: [{ name: "amount", type: "number", required: true, sensitive: false }],
      steps: [step({ id: "step-1", actionType: "navigate", url: "/x" })],
    });
    const state = { url: "http://x", text: "" };
    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async () => ({ ok: true, url: state.url }));

    await expect(
      replay({ artifact, params: { amount: "not-a-number" }, surface, policy, logger: fakeLogger(), runId: "r1" })
    ).rejects.toThrow(/declared type "number"/);
  });

  it("throws when a required param is missing", async () => {
    const artifact = makeArtifact({
      inputParams: [{ name: "memberId", type: "string", required: true, sensitive: false }],
      steps: [],
    });
    const state = { url: "http://x", text: "" };
    const { policy } = fakePolicy();
    const surface = fakeSurface(state, async () => ({ ok: true, url: state.url }));

    await expect(replay({ artifact, params: {}, surface, policy, logger: fakeLogger(), runId: "r1" })).rejects.toThrow(/Missing required/);
  });
});
