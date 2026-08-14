import { describe, expect, it } from "vitest";
import { evaluateCheckpoint } from "./checkpoint.js";
import type { Action, ActionResult, PredictedNavigation, StateSnapshot, Surface } from "../surface/types.js";

function fakeSurface(overrides: Partial<Surface>): Surface {
  return {
    observe: async (): Promise<StateSnapshot> => {
      throw new Error("not implemented in fake");
    },
    perform: async (_action: Action): Promise<ActionResult> => ({ ok: false, error: "not implemented in fake", url: "" }),
    predictNavigation: async (_action: Action): Promise<PredictedNavigation | null> => null,
    getVisibleText: async () => "",
    screenshot: async () => "",
    currentUrl: () => "",
    close: async () => undefined,
    ...overrides,
  };
}

describe("evaluateCheckpoint: url", () => {
  it("substitutes a {param} placeholder from paramValues", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/members/10001" });
    const ok = await evaluateCheckpoint(
      surface,
      { kind: "url", expr: "/members/{memberId}", description: "" },
      { memberId: "10001" }
    );
    expect(ok).toBe(true);
  });

  it("rejects when the param value doesn't match the actual segment", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/members/99999" });
    const ok = await evaluateCheckpoint(
      surface,
      { kind: "url", expr: "/members/{memberId}", description: "" },
      { memberId: "10001" }
    );
    expect(ok).toBe(false);
  });

  it("matches a '*' wildcard segment against anything", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/members/10001/sub-accounts/SA-00007/confirm" });
    const ok = await evaluateCheckpoint(
      surface,
      { kind: "url", expr: "/members/{memberId}/sub-accounts/*/confirm", description: "" },
      { memberId: "10001" }
    );
    expect(ok).toBe(true);
  });

  it("rejects when segment counts differ", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/login" });
    const ok = await evaluateCheckpoint(surface, { kind: "url", expr: "/members/{memberId}", description: "" }, { memberId: "10001" });
    expect(ok).toBe(false);
  });

  it("returns false instead of throwing when currentUrl() is empty", async () => {
    const surface = fakeSurface({ currentUrl: () => "" });
    const ok = await evaluateCheckpoint(surface, { kind: "url", expr: "/search", description: "" }, {});
    expect(ok).toBe(false);
  });

  it("percent-decodes path segments before comparing against raw param values", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/members/Acme%20Corp" });
    const ok = await evaluateCheckpoint(surface, { kind: "url", expr: "/members/{memberId}", description: "" }, { memberId: "Acme Corp" });
    expect(ok).toBe(true);
  });

  it("matches the query string too when the template includes one", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/search?memberId=40404" });
    const matching = await evaluateCheckpoint(surface, { kind: "url", expr: "/search?memberId=40404", description: "" }, {});
    const mismatching = await evaluateCheckpoint(surface, { kind: "url", expr: "/search?memberId=99999", description: "" }, {});
    expect(matching).toBe(true);
    expect(mismatching).toBe(false);
  });

  it("ignores the query string when the template has none (backward compatible)", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/search?memberId=40404" });
    const ok = await evaluateCheckpoint(surface, { kind: "url", expr: "/search", description: "" }, {});
    expect(ok).toBe(true);
  });

  it("matches multiple distinct {param} segments independently", async () => {
    const surface = fakeSurface({ currentUrl: () => "http://localhost:4000/a/b" });
    const ok = await evaluateCheckpoint(surface, { kind: "url", expr: "/{first}/{second}", description: "" }, { first: "a", second: "b" });
    expect(ok).toBe(true);
  });
});

describe("evaluateCheckpoint: text_match", () => {
  it("matches case-insensitively as a substring", async () => {
    const surface = fakeSurface({ getVisibleText: async () => "Error: NO MEMBER FOUND with ID 40404." });
    const ok = await evaluateCheckpoint(surface, { kind: "text_match", expr: "no member found", description: "" }, {});
    expect(ok).toBe(true);
  });

  it("returns false when the text isn't present", async () => {
    const surface = fakeSurface({ getVisibleText: async () => "Sub-account opened successfully." });
    const ok = await evaluateCheckpoint(surface, { kind: "text_match", expr: "access denied", description: "" }, {});
    expect(ok).toBe(false);
  });
});

describe("evaluateCheckpoint: element_visible", () => {
  it("parses the JSON-encoded candidates and forwards them to perform() as an extract action", async () => {
    let receivedAction: Action | undefined;
    const surface = fakeSurface({
      perform: async (action) => {
        receivedAction = action;
        return { ok: true, url: "" };
      },
    });
    const candidates = [{ strategy: "text" as const, name: "Confirmation Number", nth: 0, confidence: "medium" as const, rationale: "" }];
    const ok = await evaluateCheckpoint(surface, { kind: "element_visible", expr: JSON.stringify(candidates), description: "" }, {});
    expect(ok).toBe(true);
    expect(receivedAction).toEqual({ type: "extract", target: candidates });
  });

  it("resolves false when the locator fails to resolve", async () => {
    const surface = fakeSurface({ perform: async () => ({ ok: false, error: "not found", url: "" }) });
    const candidates = [{ strategy: "text" as const, name: "Nonexistent", nth: 0, confidence: "medium" as const, rationale: "" }];
    const ok = await evaluateCheckpoint(surface, { kind: "element_visible", expr: JSON.stringify(candidates), description: "" }, {});
    expect(ok).toBe(false);
  });

  it("returns false instead of throwing on a malformed (non-JSON) expr", async () => {
    const surface = fakeSurface({});
    const ok = await evaluateCheckpoint(surface, { kind: "element_visible", expr: "{not valid json", description: "" }, {});
    expect(ok).toBe(false);
  });
});
