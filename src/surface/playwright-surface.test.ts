import { describe, expect, it, vi } from "vitest";
import { PlaywrightSurface } from "./playwright-surface.js";

/**
 * getVisibleText() is the one PlaywrightSurface method worth a fast unit test rather than
 * only real evidence: its retry-on-transient-navigation-race logic is pure control flow
 * around `page.evaluate`, cheaply faked without a real browser. Everything else in this file
 * (locator resolution, actual clicking/typing against a real DOM) stays verified by real
 * evidence runs, per this repo's own testing philosophy for Surface-touching code.
 */
function makeSurfaceWithFakePage(evaluateImpl: () => Promise<string>, waitForLoadState = vi.fn().mockResolvedValue(undefined)) {
  const surface = new PlaywrightSurface({ evidenceDir: "/tmp/playwright-surface-test", headed: false });
  const fakePage = { evaluate: vi.fn(evaluateImpl), waitForLoadState };
  // `page` is private -- there is no real page without launch()'ing an actual browser, which
  // would defeat the point of a fast unit test for pure retry control flow.
  (surface as unknown as { page: unknown }).page = fakePage;
  return { surface, fakePage };
}

describe("PlaywrightSurface.getVisibleText -- retry on a transient navigation race", () => {
  it("returns the text directly when evaluate succeeds on the first try", async () => {
    const { surface, fakePage } = makeSurfaceWithFakePage(async () => "hello");
    await expect(surface.getVisibleText()).resolves.toBe("hello");
    expect(fakePage.evaluate).toHaveBeenCalledTimes(1);
  });

  it("retries once, after waiting for load state, on the exact known-transient error, and returns the retry's result", async () => {
    let call = 0;
    const { surface, fakePage } = makeSurfaceWithFakePage(async () => {
      call += 1;
      if (call === 1) throw new Error("Execution context was destroyed, most likely because of a navigation");
      return "settled page text";
    });
    await expect(surface.getVisibleText()).resolves.toBe("settled page text");
    expect(fakePage.evaluate).toHaveBeenCalledTimes(2);
    expect(fakePage.waitForLoadState).toHaveBeenCalledTimes(1);
  });

  it("re-throws immediately for a different error -- only this one known-transient message gets a retry", async () => {
    const { surface, fakePage } = makeSurfaceWithFakePage(async () => {
      throw new Error("some other real failure");
    });
    await expect(surface.getVisibleText()).rejects.toThrow("some other real failure");
    expect(fakePage.evaluate).toHaveBeenCalledTimes(1);
  });

  it("propagates a second real failure rather than retrying forever or swallowing it", async () => {
    const { surface } = makeSurfaceWithFakePage(async () => {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    });
    await expect(surface.getVisibleText()).rejects.toThrow("Execution context was destroyed");
  });
});
