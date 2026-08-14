import { describe, expect, it } from "vitest";
import { isBaseUrlAllowed, matchRoute, type AllowlistConfig } from "./allowlist.js";

const config: AllowlistConfig = {
  allowedBaseUrls: ["http://localhost:4000"],
  routes: [
    { pattern: "/search", methods: ["GET"], risk: "safe" },
    { pattern: "/members/:id", methods: ["GET"], risk: "safe" },
    { pattern: "/members/:id/sub-accounts", methods: ["POST"], risk: "risky" },
  ],
};

describe("matchRoute", () => {
  it("matches a static route", () => {
    expect(matchRoute(config, "/search", "GET")?.rule.risk).toBe("safe");
  });

  it("matches a :param segment against any concrete value", () => {
    const match = matchRoute(config, "/members/10001", "GET");
    expect(match?.rule.pattern).toBe("/members/:id");
  });

  it("does not match when the method differs", () => {
    expect(matchRoute(config, "/members/10001", "POST")).toBeNull();
  });

  it("does not match an unlisted path", () => {
    expect(matchRoute(config, "/admin/danger", "GET")).toBeNull();
  });

  it("classifies the sub-accounts POST route as risky", () => {
    expect(matchRoute(config, "/members/10001/sub-accounts", "POST")?.rule.risk).toBe("risky");
  });

  it("does not let a :param segment swallow an extra path segment", () => {
    // /members/:id must not match /members/10001/sub-accounts/new (different rule, different length)
    expect(matchRoute(config, "/members/10001/sub-accounts/new", "GET")).toBeNull();
  });
});

describe("isBaseUrlAllowed", () => {
  it("allows a URL under an allowed base", () => {
    expect(isBaseUrlAllowed(config, "http://localhost:4000/members/10001")).toBe(true);
  });

  it("rejects a URL outside every allowed base", () => {
    expect(isBaseUrlAllowed(config, "http://evil.example.com/members/10001")).toBe(false);
  });
});
