import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelList, withModelFallback, withModelRetry } from "./model-retry.js";
import type { EvidenceLogger } from "../evidence/logger.js";

function fakeLogger(): EvidenceLogger {
  return { log: () => undefined, addSensitiveKeys: () => undefined, addSensitiveValue: () => undefined, writeJson: () => "" } as unknown as EvidenceLogger;
}

function errorWithStatus(status: number, message = "error"): Error {
  return Object.assign(new Error(message), { status });
}

function dailyQuotaError(): Error {
  return Object.assign(
    new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}'),
    { status: 429 }
  );
}

describe("withModelRetry", () => {
  it("returns the result immediately on success, no retry needed", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withModelRetry(fn, fakeLogger());
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a 429 rate-limit error and eventually succeeds", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(errorWithStatus(429, "rate limited")).mockResolvedValueOnce("ok");
    const promise = withModelRetry(fn, fakeLogger());
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries on a transient 5xx server error", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(errorWithStatus(503, "high demand")).mockResolvedValueOnce("ok");
    const promise = withModelRetry(fn, fakeLogger());
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("works with no logger at all (e.g. a caller like the planner that has no evidence trail of its own)", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(errorWithStatus(503, "high demand")).mockResolvedValueOnce("ok");
    const promise = withModelRetry(fn);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    vi.useRealTimers();
  });

  it("does not retry a non-transient error (e.g. a 400 bad request) -- fails immediately", async () => {
    const fn = vi.fn().mockRejectedValue(errorWithStatus(400, "bad request"));
    await expect(withModelRetry(fn, fakeLogger())).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up and throws after maxAttempts consecutive transient failures", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(errorWithStatus(503, "still down"));
    const promise = withModelRetry(fn, fakeLogger(), 3);
    const expectation = expect(promise).rejects.toThrow("still down");
    await vi.runAllTimersAsync();
    await expectation;
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("withModelFallback", () => {
  it("returns the result immediately on success against the primary model, no fallback needed", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withModelFallback(["primary", "secondary"], fn, fakeLogger());
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("primary");
  });

  it("retries the SAME model on a per-minute rate limit, same as withModelRetry, before ever trying the next model", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(errorWithStatus(429, "rate limited")).mockResolvedValueOnce("ok");
    const promise = withModelFallback(["primary", "secondary"], fn, fakeLogger());
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "primary");
    expect(fn).toHaveBeenNthCalledWith(2, "primary");
    vi.useRealTimers();
  });

  it("falls back to the next model immediately (no backoff wait) on a daily-quota-exhausted error", async () => {
    const fn = vi.fn().mockRejectedValueOnce(dailyQuotaError()).mockResolvedValueOnce("ok");
    const result = await withModelFallback(["primary", "secondary"], fn, fakeLogger());
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "primary");
    expect(fn).toHaveBeenNthCalledWith(2, "secondary");
  });

  it("throws a clear error once every configured model has exhausted its daily quota", async () => {
    const fn = vi.fn().mockRejectedValue(dailyQuotaError());
    await expect(withModelFallback(["primary", "secondary"], fn, fakeLogger())).rejects.toThrow(/all configured gemini models/i);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry or fall back on a non-transient error (e.g. a 400 bad request)", async () => {
    const fn = vi.fn().mockRejectedValue(errorWithStatus(400, "bad request"));
    await expect(withModelFallback(["primary", "secondary"], fn, fakeLogger())).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty model list rather than silently doing nothing", async () => {
    await expect(withModelFallback([], vi.fn(), fakeLogger())).rejects.toThrow(/at least one model/i);
  });
});

describe("resolveModelList", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("defaults to gemini-3.7-flash with no fallbacks when nothing is configured", () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODELS;
    expect(resolveModelList()).toEqual(["gemini-3.7-flash"]);
  });

  it("puts GEMINI_MODEL first, then each GEMINI_FALLBACK_MODELS entry in order", () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-2.5-flash, gemini-2.0-flash";
    expect(resolveModelList()).toEqual(["gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);
  });

  it("drops a fallback entry that duplicates the primary model, and tolerates blank entries", () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.5-flash-lite,,gemini-2.0-flash,";
    expect(resolveModelList()).toEqual(["gemini-3.5-flash-lite", "gemini-2.0-flash"]);
  });
});
