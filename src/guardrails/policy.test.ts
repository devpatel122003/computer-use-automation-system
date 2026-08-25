import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardrailsPolicy } from "./policy.js";
import type { Action, ActionResult, PredictedNavigation, StateSnapshot, Surface } from "../surface/types.js";

function writeTempAllowlist(): string {
  const file = path.join(os.tmpdir(), `allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      allowedBaseUrls: ["http://localhost:4000"],
      routes: [{ pattern: "/members/:id/sub-accounts", methods: ["POST"], risk: "risky" }],
    })
  );
  return file;
}

function fakeSurface(predictNavigation: Surface["predictNavigation"]): Surface {
  return {
    observe: async (): Promise<StateSnapshot> => {
      throw new Error("not used");
    },
    perform: async (_action: Action): Promise<ActionResult> => ({ ok: false, error: "not used", url: "" }),
    predictNavigation,
    getVisibleText: async () => "",
    screenshot: async () => "",
    currentUrl: () => "",
    close: async () => undefined,
  };
}

const clickAction: Action = { type: "click", target: [{ strategy: "text", name: "X", nth: 0, confidence: "medium", rationale: "" }] };

describe("GuardrailsPolicy.authorize -- predictNavigation's three-way return", () => {
  it("treats an unresolved element (undefined) as safe -- lets perform() fail naturally", async () => {
    // Regression: this must NOT be conflated with the "ambiguous destination" case below.
    // A step whose target only exists on the happy-path variant of a page (e.g. a link
    // that isn't rendered on a permission-denied page) should be free to fail mechanically
    // and flow through known-outcome detection, not get misfiled as a guardrail block.
    const policy = new GuardrailsPolicy(writeTempAllowlist());
    const surface = fakeSurface(async () => undefined);
    const result = await policy.authorize(surface, clickAction);
    expect(result.allowed).toBe(true);
  });

  it("fails CLOSED on a resolved element with a genuinely ambiguous destination (null)", async () => {
    const policy = new GuardrailsPolicy(writeTempAllowlist());
    const surface = fakeSurface(async () => null);
    const result = await policy.authorize(surface, clickAction);
    expect(result.allowed).toBe(false);
  });

  it("classifies click_coordinates as risky but ALLOWED, never blocked outright -- a coordinate click's destination can never be verified in advance (there's no DOM to inspect), so blocking it would make the vision fallback permanently inert, same as treating it 'safe' would let it bypass confirmation entirely", async () => {
    const policy = new GuardrailsPolicy(writeTempAllowlist());
    const surface = fakeSurface(async () => {
      throw new Error("predictNavigation should never be consulted for click_coordinates");
    });
    const result = await policy.authorize(surface, { type: "click_coordinates", x: 10, y: 20 });
    expect(result.allowed).toBe(true);
    expect(result.risk).toBe("risky");
  });

  it("checks a known destination against the allowlist as usual", async () => {
    const policy = new GuardrailsPolicy(writeTempAllowlist());
    const allowed: PredictedNavigation = { url: "http://localhost:4000/members/1/sub-accounts", method: "POST" };
    const blocked: PredictedNavigation = { url: "http://evil.example.com/steal", method: "POST" };

    const allowedResult = await policy.authorize(fakeSurface(async () => allowed), clickAction);
    const blockedResult = await policy.authorize(fakeSurface(async () => blocked), clickAction);

    expect(allowedResult.allowed).toBe(true);
    expect(allowedResult.risk).toBe("risky");
    expect(blockedResult.allowed).toBe(false);
  });
});
