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

  // These three all previously passed under a plain `String.startsWith` prefix check --
  // each one literally starts with "http://localhost:4000" as a string, while resolving to
  // a completely different origin as a URL. This is the exact allowlist bypass found in review.
  it("rejects a different port that happens to share the allowed port as a numeric prefix", () => {
    expect(isBaseUrlAllowed(config, "http://localhost:40000/login")).toBe(false);
  });

  it("rejects a subdomain-confusion host that string-prefixes the allowed origin", () => {
    expect(isBaseUrlAllowed(config, "http://localhost:4000.evil.example.com/login")).toBe(false);
  });

  it("rejects a userinfo-based bypass (browsers resolve this to evil.com)", () => {
    expect(isBaseUrlAllowed(config, "http://localhost:4000@evil.com/login")).toBe(false);
  });

  it("rejects a malformed URL rather than throwing", () => {
    expect(isBaseUrlAllowed(config, "not a url")).toBe(false);
  });

  it("requires a full path-segment match when the allowed base itself has a path prefix", () => {
    const scoped: AllowlistConfig = { allowedBaseUrls: ["http://localhost:4000/app"], routes: [] };
    expect(isBaseUrlAllowed(scoped, "http://localhost:4000/app/members")).toBe(true);
    expect(isBaseUrlAllowed(scoped, "http://localhost:4000/app-danger")).toBe(false);
  });
});
