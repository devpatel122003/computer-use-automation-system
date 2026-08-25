import { describe, expect, it } from "vitest";
import { redactionOptionsFor, summarize } from "./agent-chat.js";
import { redact } from "../guardrails/redaction.js";
import type { DiscoveredCapability } from "../frontend/planner.js";

describe("summarize", () => {
  it("reports a success with its outputs, deterministically -- no LLM call to phrase this", () => {
    expect(summarize({ status: "success", outputs: { confirmationNumber: "SA-00001" } }, 200)).toBe(
      "Done. confirmationNumber = SA-00001."
    );
  });

  it("reports a success with no outputs", () => {
    expect(summarize({ status: "success", outputs: {} }, 200)).toBe("Done.");
  });

  it("reports a business_outcome as completed-with-an-answer, not a failure", () => {
    expect(summarize({ status: "business_outcome", outcome: "member_not_found", description: "No such member." }, 200)).toBe(
      'Completed, but the answer is "member_not_found": No such member.'
    );
  });

  it("reports a failure with the expected/observed debug detail", () => {
    expect(summarize({ status: "failure", stepId: "step-10", expected: "confirmation to proceed", observed: "no confirmation given" }, 422)).toBe(
      "Didn't complete. At step step-10, expected confirmation to proceed but observed no confirmation given."
    );
  });

  it("reports a client-side error (e.g. missing params, unknown capability) distinctly from a replay failure", () => {
    expect(summarize({ status: "failure", error: "No capability artifact found with id \"x\"." }, 404)).toBe(
      'Couldn\'t even start: No capability artifact found with id "x".'
    );
  });
});

const capabilities: DiscoveredCapability[] = [
  {
    id: "open-sub-account",
    description: "d",
    inputParams: [
      { name: "username", type: "string", required: true, sensitive: false },
      { name: "password", type: "string", required: true, sensitive: true },
      { name: "memberId", type: "string", required: true, sensitive: false },
    ],
  },
];

describe("redactionOptionsFor", () => {
  it("collects only the sensitive param names/values for the chosen capability", () => {
    const opts = redactionOptionsFor(capabilities, {
      capabilityId: "open-sub-account",
      params: { username: "demo_operator", password: "demo_password", memberId: "10001" },
    });
    expect(opts.sensitiveKeys).toEqual(new Set(["password"]));
    expect(opts.sensitiveValues).toEqual(new Set(["demo_password"]));
  });

  it("actually redacts a raw utterance containing the credential in plain English -- the real leak this exists to close", () => {
    const opts = redactionOptionsFor(capabilities, {
      capabilityId: "open-sub-account",
      params: { username: "demo_operator", password: "demo_password", memberId: "10001" },
    });
    const utterance = "Using operator demo_operator and password demo_password, open an account for member 10001";
    const redacted = redact(utterance, opts) as string;
    expect(redacted).not.toContain("demo_password");
    expect(redacted).toContain("demo_operator"); // only the sensitive field is scrubbed, not every param
  });

  it("returns empty sets when the capability id doesn't match anything discovered", () => {
    const opts = redactionOptionsFor(capabilities, { capabilityId: "no-such-capability", params: { password: "x" } });
    expect(opts.sensitiveKeys.size).toBe(0);
  });
});
