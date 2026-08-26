import { describe, expect, it } from "vitest";
import { resolveInterventionDecision } from "./controller.js";

describe("resolveInterventionDecision", () => {
  it("resumes on a real, deliberate blank Enter (an empty string answer)", () => {
    expect(resolveInterventionDecision("")).toBe("resume");
  });

  it("resumes on any real answer that isn't 'abort'", () => {
    expect(resolveInterventionDecision("done")).toBe("resume");
    expect(resolveInterventionDecision("  ")).toBe("resume");
  });

  it("aborts on an explicit 'abort' answer, case- and whitespace-insensitively", () => {
    expect(resolveInterventionDecision("abort")).toBe("abort");
    expect(resolveInterventionDecision("  ABORT  ")).toBe("abort");
  });

  it("aborts on null -- stdin closed with no one able to answer at all, NOT the same as a deliberate blank Enter", () => {
    // Regression coverage for a real bug: before promptLine distinguished "stream closed"
    // (null) from "a human pressed Enter" (""), both collapsed to the same empty string,
    // and this function would have resolved a genuinely unattended, unanswered escalation
    // as "resume" -- silently continuing a run no human ever actually reviewed.
    expect(resolveInterventionDecision(null)).toBe("abort");
  });
});
