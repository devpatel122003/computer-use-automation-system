import { describe, expect, it } from "vitest";
import { explainDeclinedRisky } from "./agent-invoke-demo.js";

describe("explainDeclinedRisky", () => {
  it("blames draft state when the capability has never been approved", () => {
    expect(explainDeclinedRisky("draft")).toMatch(/isn't "approved" yet/);
  });

  // Regression coverage for a real inaccuracy found while re-verifying this demo script from
  // a fresh clone: once a capability is `approved` but its confidence has dropped back to
  // "low" (e.g. after a real declined-risky or failure run), the API declines the exact same
  // way as a draft artifact would -- but the old hardcoded message always claimed "isn't
  // approved yet" regardless, which is simply false once approvalState is "approved".
  it("blames confidence/drift, not approval state, when the capability is already approved", () => {
    const message = explainDeclinedRisky("approved");
    expect(message).toMatch(/already "approved/);
    expect(message).not.toMatch(/isn't "approved" yet/);
  });
});
