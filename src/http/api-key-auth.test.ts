import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { extractBearerToken, requireApiKey, requireBasicAuth } from "./api-key-auth.js";
import type { OperatorConfigEntry } from "./operator-registry.js";

function fakeReq(headers: Record<string, string>): Request {
  return { header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as unknown as Response["json"];
  res.setHeader = vi.fn(() => res as Response) as unknown as Response["setHeader"];
  return res as Response & { statusCode?: number; body?: unknown };
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("returns null for a missing header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for a header that isn't the Bearer scheme", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull();
  });
});

describe("requireApiKey", () => {
  it("throws at setup time if no operator has a usable API key -- fails closed, not silently open", () => {
    expect(() => requireApiKey([{ id: "alice" }])).toThrow(/No operator/);
  });

  it("returns 401 when no credential is provided", () => {
    process.env.TEST_AKA_1 = "correct-key";
    const middleware = requireApiKey([{ id: "alice", apiKeyEnvVar: "TEST_AKA_1" }]);
    const req = fakeReq({});
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the wrong key is provided via Authorization", () => {
    process.env.TEST_AKA_2 = "correct-key";
    const middleware = requireApiKey([{ id: "alice", apiKeyEnvVar: "TEST_AKA_2" }]);
    const req = fakeReq({ authorization: "Bearer wrong-key" });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and sets req.operatorId when the correct key is provided via Authorization: Bearer", () => {
    process.env.TEST_AKA_3 = "correct-key";
    const middleware = requireApiKey([{ id: "alice", apiKeyEnvVar: "TEST_AKA_3" }]);
    const req = fakeReq({ authorization: "Bearer correct-key" });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
    expect(req.operatorId).toBe("alice");
  });

  it("also accepts the key via the X-API-Key header", () => {
    process.env.TEST_AKA_4 = "correct-key";
    const middleware = requireApiKey([{ id: "alice", apiKeyEnvVar: "TEST_AKA_4" }]);
    const req = fakeReq({ "x-api-key": "correct-key" });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a key that differs only in length from the correct one, without throwing", () => {
    process.env.TEST_AKA_5 = "correct-key";
    const middleware = requireApiKey([{ id: "alice", apiKeyEnvVar: "TEST_AKA_5" }]);
    const req = fakeReq({ authorization: "Bearer short" });
    const res = fakeRes();
    const next = vi.fn();

    expect(() => middleware(req, res, next)).not.toThrow();
    expect(res.statusCode).toBe(401);
  });

  it("resolves each of several operators to their own distinct id", () => {
    process.env.TEST_AKA_ALICE = "alice-key";
    process.env.TEST_AKA_BOB = "bob-key";
    const middleware = requireApiKey([
      { id: "alice", apiKeyEnvVar: "TEST_AKA_ALICE" },
      { id: "bob", apiKeyEnvVar: "TEST_AKA_BOB" },
    ]);

    const reqAlice = fakeReq({ authorization: "Bearer alice-key" });
    middleware(reqAlice, fakeRes(), vi.fn());
    expect(reqAlice.operatorId).toBe("alice");

    const reqBob = fakeReq({ authorization: "Bearer bob-key" });
    middleware(reqBob, fakeRes(), vi.fn());
    expect(reqBob.operatorId).toBe("bob");
  });
});

describe("requireBasicAuth", () => {
  const entries: OperatorConfigEntry[] = [{ id: "alice", dashboardUsername: "alice", dashboardPasswordEnvVar: "TEST_DASH_ALICE" }];

  it("throws at setup time if no operator has dashboard credentials configured", () => {
    expect(() => requireBasicAuth([{ id: "alice" }])).toThrow(/No operator/);
  });

  it("returns 401 with a WWW-Authenticate header when no credential is provided -- browsers use this to prompt", () => {
    process.env.TEST_DASH_ALICE = "correct-password";
    const middleware = requireBasicAuth(entries);
    const req = fakeReq({});
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.setHeader).toHaveBeenCalledWith("WWW-Authenticate", expect.stringContaining("Basic"));
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the username matches but the password is wrong", () => {
    process.env.TEST_DASH_ALICE = "correct-password";
    const middleware = requireBasicAuth(entries);
    const req = fakeReq({ authorization: basicAuthHeader("alice", "wrong-password") });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the password is correct but the username doesn't match any configured operator", () => {
    process.env.TEST_DASH_ALICE = "correct-password";
    const middleware = requireBasicAuth(entries);
    const req = fakeReq({ authorization: basicAuthHeader("nobody", "correct-password") });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and sets req.operatorId when both username and password match a configured operator", () => {
    process.env.TEST_DASH_ALICE = "correct-password";
    const middleware = requireBasicAuth(entries);
    const req = fakeReq({ authorization: basicAuthHeader("alice", "correct-password") });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.operatorId).toBe("alice");
  });

  it("resolves two operators with distinct username/password pairs independently, rejecting a cross-mix", () => {
    process.env.TEST_DASH_ALICE_2 = "alice-pw";
    process.env.TEST_DASH_BOB_2 = "bob-pw";
    const middleware = requireBasicAuth([
      { id: "alice", dashboardUsername: "alice", dashboardPasswordEnvVar: "TEST_DASH_ALICE_2" },
      { id: "bob", dashboardUsername: "bob", dashboardPasswordEnvVar: "TEST_DASH_BOB_2" },
    ]);

    // alice's username with bob's password: rejected.
    const mixed = fakeReq({ authorization: basicAuthHeader("alice", "bob-pw") });
    const mixedRes = fakeRes();
    middleware(mixed, mixedRes, vi.fn());
    expect(mixedRes.statusCode).toBe(401);

    // each operator's own correct pairing resolves their own id.
    const reqAlice = fakeReq({ authorization: basicAuthHeader("alice", "alice-pw") });
    middleware(reqAlice, fakeRes(), vi.fn());
    expect(reqAlice.operatorId).toBe("alice");

    const reqBob = fakeReq({ authorization: basicAuthHeader("bob", "bob-pw") });
    middleware(reqBob, fakeRes(), vi.fn());
    expect(reqBob.operatorId).toBe("bob");
  });
});
