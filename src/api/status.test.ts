import { describe, expect, it } from "vitest";
import { statusCodeFor } from "./status.js";
import type { ReplayResult } from "../replay/types.js";

describe("statusCodeFor", () => {
  it("maps success to 200", () => {
    const result: ReplayResult = { status: "success", runId: "r", outputs: {} };
    expect(statusCodeFor(result)).toBe(200);
  });

  it("maps business_outcome to 200 -- it's the caller's answer, not an error", () => {
    const result: ReplayResult = { status: "business_outcome", runId: "r", outcome: "member_not_found", description: "d" };
    expect(statusCodeFor(result)).toBe(200);
  });

  it("maps failure to 422", () => {
    const result: ReplayResult = { status: "failure", runId: "r", stepId: "step-1", expected: "e", observed: "o", evidenceRef: "path" };
    expect(statusCodeFor(result)).toBe(422);
  });
});
