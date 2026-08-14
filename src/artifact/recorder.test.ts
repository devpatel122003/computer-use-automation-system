import { describe, expect, it } from "vitest";
import { attachStepCheckpoint, buildArtifact, type ParamMapping } from "./recorder.js";
import type { DiscoveryResult } from "../agent/types.js";
import type { LocatorCandidate } from "./schema.js";

function locator(name: string, role: LocatorCandidate["role"]): LocatorCandidate[] {
  return [{ strategy: "role", role, name, nth: 0, confidence: "high", rationale: "test fixture" }];
}

function makeDiscoveryResult(): DiscoveryResult {
  return {
    status: "finished",
    goal: "test goal",
    startUrl: "http://localhost:4000/login",
    outputs: { savingsBalance: "$12,500.00" },
    finalSummary: "done",
    steps: [
      {
        stepIndex: 0,
        observation: { url: "http://localhost:4000/login", title: "", elements: [], screenshotPath: "" },
        toolName: "navigate",
        toolInput: { url: "http://localhost:4000/login" },
        action: { type: "navigate", url: "http://localhost:4000/login" },
        actionResult: { ok: true, url: "http://localhost:4000/login" },
      },
      {
        stepIndex: 1,
        observation: { url: "http://localhost:4000/login", title: "", elements: [], screenshotPath: "" },
        toolName: "type",
        toolInput: { role: "textbox", name: "Operator ID", text: "demo_operator" },
        action: { type: "type", target: locator("Operator ID", "textbox"), text: "demo_operator" },
        actionResult: { ok: true, url: "http://localhost:4000/login" },
        risk: "safe",
      },
      {
        stepIndex: 2,
        observation: { url: "http://localhost:4000/login", title: "", elements: [], screenshotPath: "" },
        toolName: "type",
        toolInput: { role: "textbox", name: "Password", text: "demo_password" },
        action: { type: "type", target: locator("Password", "textbox"), text: "demo_password" },
        actionResult: { ok: true, url: "http://localhost:4000/login" },
        risk: "safe",
      },
      {
        stepIndex: 3,
        observation: { url: "http://localhost:4000/login", title: "", elements: [], screenshotPath: "" },
        toolName: "click",
        toolInput: { role: "button", name: "Sign On" },
        action: { type: "click", target: locator("Sign On", "button") },
        actionResult: { ok: true, url: "http://localhost:4000/search" },
        risk: "safe",
      },
      {
        stepIndex: 4,
        observation: { url: "http://localhost:4000/search", title: "", elements: [], screenshotPath: "" },
        toolName: "extract",
        toolInput: { role: "text", name: "Savings Balance", as: "savingsBalance" },
        action: { type: "extract", target: locator("Savings Balance", "text") },
        actionResult: { ok: true, url: "http://localhost:4000/search", extractedValue: "$12,500.00" },
        risk: "safe",
      },
      // A control step (finish) -- no `action`, should be skipped entirely, not become a step.
      {
        stepIndex: 5,
        observation: { url: "http://localhost:4000/search", title: "", elements: [], screenshotPath: "" },
        toolName: "finish",
        toolInput: { success: true, summary: "done" },
      },
    ],
  };
}

const PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "Operator ID", paramName: "username", type: "string" },
  { role: "textbox", name: "Password", paramName: "password", type: "string", sensitive: true },
];

function record(discovery: DiscoveryResult) {
  return buildArtifact(discovery, {
    id: "test-capability",
    name: "Test Capability",
    description: "d",
    version: "1.0.0",
    appId: "mock-bank",
    baseUrlPattern: "http://localhost:4000",
    paramMappings: PARAM_MAPPINGS,
    successCheckpoint: { kind: "text_match", expr: "OK", description: "" },
    knownOutcomes: [],
  });
}

describe("buildArtifact", () => {
  it("throws if the discovery run didn't finish", () => {
    expect(() => record({ ...makeDiscoveryResult(), status: "escalated" })).toThrow();
  });

  it("skips control steps (finish/escalate) that have no action", () => {
    const artifact = record(makeDiscoveryResult());
    expect(artifact.steps.every((s) => s.actionType !== undefined)).toBe(true);
    expect(artifact.steps).toHaveLength(5); // navigate + 2 type + click + extract, not the finish step
  });

  it("parameterizes a mapped field via paramRef, marking it sensitive when configured", () => {
    const artifact = record(makeDiscoveryResult());
    const usernameParam = artifact.inputParams.find((p) => p.name === "username");
    const passwordParam = artifact.inputParams.find((p) => p.name === "password");
    expect(usernameParam?.sensitive).toBe(false);
    expect(passwordParam?.sensitive).toBe(true);

    const usernameStep = artifact.steps.find((s) => s.description.includes("Operator ID"));
    expect(usernameStep?.input).toEqual({ paramRef: "username" });
  });

  it("keeps an unmapped field as a literal, not a parameter", () => {
    // "Sign On" is a click with no text/option input, so this specifically checks that a
    // field with no ParamMapping entry doesn't spuriously become a parameter.
    const artifact = record(makeDiscoveryResult());
    expect(artifact.inputParams.find((p) => p.name === "Sign On")).toBeUndefined();
  });

  it("records an extract step's output in outputSchema", () => {
    const artifact = record(makeDiscoveryResult());
    expect(artifact.outputSchema).toHaveLength(1);
    expect(artifact.outputSchema[0]?.name).toBe("savingsBalance");
  });

  it("preserves the recorded locator fallback chain on each step", () => {
    const artifact = record(makeDiscoveryResult());
    const clickStep = artifact.steps.find((s) => s.actionType === "click");
    expect(clickStep?.locator?.[0]).toMatchObject({ strategy: "role", role: "button", name: "Sign On" });
  });
});

describe("attachStepCheckpoint", () => {
  it("attaches a checkpoint to the first step matching the predicate", () => {
    const artifact = record(makeDiscoveryResult());
    attachStepCheckpoint(artifact, (s) => s.actionType === "click", {
      kind: "url",
      expr: "/search",
      description: "reached search",
    });
    const clickStep = artifact.steps.find((s) => s.actionType === "click");
    expect(clickStep?.checkpoint?.expr).toBe("/search");
  });

  it("is a no-op when no step matches", () => {
    const artifact = record(makeDiscoveryResult());
    expect(() => attachStepCheckpoint(artifact, () => false, { kind: "url", expr: "/x", description: "" })).not.toThrow();
  });
});
