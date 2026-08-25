import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { extractBearerToken, requireApiKey, requireBasicAuth } from "./api-key-auth.js";

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
  const ENV_VAR = "TEST_API_KEY_VAR";
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalValue;
  });

  it("throws at setup time if the expected env var isn't configured -- fails closed, not silently open", () => {
    delete process.env[ENV_VAR];
    expect(() => requireApiKey(ENV_VAR)).toThrow(/is not set/);
  });

  it("returns 401 when no credential is provided", () => {
    process.env[ENV_VAR] = "correct-key";
    const middleware = requireApiKey(ENV_VAR);
    const req = fakeReq({});
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the wrong key is provided via Authorization", () => {
    process.env[ENV_VAR] = "correct-key";
    const middleware = requireApiKey(ENV_VAR);
    const req = fakeReq({ authorization: "Bearer wrong-key" });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the correct key is provided via Authorization: Bearer", () => {
    process.env[ENV_VAR] = "correct-key";
    const middleware = requireApiKey(ENV_VAR);
    const req = fakeReq({ authorization: "Bearer correct-key" });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("also accepts the key via the X-API-Key header", () => {
    process.env[ENV_VAR] = "correct-key";
    const middleware = requireApiKey(ENV_VAR);
    const req = fakeReq({ "x-api-key": "correct-key" });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a key that differs only in length from the correct one, without throwing", () => {
    process.env[ENV_VAR] = "correct-key";
    const middleware = requireApiKey(ENV_VAR);
    const req = fakeReq({ authorization: "Bearer short" });
    const res = fakeRes();
    const next = vi.fn();

    expect(() => middleware(req, res, next)).not.toThrow();
    expect(res.statusCode).toBe(401);
  });
});

describe("requireBasicAuth", () => {
  const ENV_VAR = "TEST_DASHBOARD_PASSWORD_VAR";
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalValue;
  });

  it("throws at setup time if the expected env var isn't configured", () => {
    delete process.env[ENV_VAR];
    expect(() => requireBasicAuth(ENV_VAR)).toThrow(/is not set/);
  });

  it("returns 401 with a WWW-Authenticate header when no credential is provided -- browsers use this to prompt", () => {
    process.env[ENV_VAR] = "correct-password";
    const middleware = requireBasicAuth(ENV_VAR);
    const req = fakeReq({});
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.setHeader).toHaveBeenCalledWith("WWW-Authenticate", expect.stringContaining("Basic"));
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the password is wrong, regardless of username", () => {
    process.env[ENV_VAR] = "correct-password";
    const middleware = requireBasicAuth(ENV_VAR);
    const req = fakeReq({ authorization: basicAuthHeader("operator", "wrong-password") });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
  });

  it("calls next() when the correct password is provided, regardless of username", () => {
    process.env[ENV_VAR] = "correct-password";
    const middleware = requireBasicAuth(ENV_VAR);
    const req = fakeReq({ authorization: basicAuthHeader("anyone", "correct-password") });
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
