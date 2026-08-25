import { describe, expect, it } from "vitest";
import { effectiveAllowRisky } from "./execution-policy.js";

describe("effectiveAllowRisky", () => {
  it("blocks whenever allowRisky wasn't requested, regardless of everything else", () => {
    expect(effectiveAllowRisky({ requestedAllowRisky: false, approvalState: "approved", driftAdjustedLabel: "high" })).toBe(false);
  });

  it("blocks a draft artifact even if requested and confidence is high", () => {
    expect(effectiveAllowRisky({ requestedAllowRisky: true, approvalState: "draft", driftAdjustedLabel: "high" })).toBe(false);
  });

  it("allows an approved artifact with high or medium drift-adjusted confidence", () => {
    expect(effectiveAllowRisky({ requestedAllowRisky: true, approvalState: "approved", driftAdjustedLabel: "high" })).toBe(true);
    expect(effectiveAllowRisky({ requestedAllowRisky: true, approvalState: "approved", driftAdjustedLabel: "medium" })).toBe(true);
  });

  it("the circuit breaker itself: blocks an approved artifact once drift has capped it to low or unproven", () => {
    expect(effectiveAllowRisky({ requestedAllowRisky: true, approvalState: "approved", driftAdjustedLabel: "low" })).toBe(false);
    expect(effectiveAllowRisky({ requestedAllowRisky: true, approvalState: "approved", driftAdjustedLabel: "unproven" })).toBe(false);
  });
});
