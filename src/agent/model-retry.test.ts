import { describe, expect, it, vi } from "vitest";
import { withModelRetry } from "./model-retry.js";
import type { EvidenceLogger } from "../evidence/logger.js";

function fakeLogger(): EvidenceLogger {
  return { log: () => undefined, addSensitiveKeys: () => undefined, addSensitiveValue: () => undefined, writeJson: () => "" } as unknown as EvidenceLogger;
}

function errorWithStatus(status: number, message = "error"): Error {
  return Object.assign(new Error(message), { status });
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
