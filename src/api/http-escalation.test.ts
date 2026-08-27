import { describe, expect, it, vi } from "vitest";
import { HttpEscalationRegistry } from "./http-escalation.js";
import type { ArtifactStep } from "../artifact/schema.js";

function fakeLogger() {
  return {
    screenshotsDir: "/tmp/fake-screenshots",
    log: vi.fn(),
    writeJson: vi.fn(),
  } as unknown as import("../evidence/logger.js").EvidenceLogger;
}

function fakePage() {
  return { screenshot: vi.fn().mockResolvedValue(undefined), url: () => "http://localhost:4000/members/77777/sub-accounts" } as unknown as import("playwright").Page;
}

const STEP = { id: "step-10" } as ArtifactStep;

describe("HttpEscalationRegistry -- the capability API's own pause/resume signal", () => {
  it("createOnEscalate's returned promise stays pending until resolve() is called for its id", async () => {
    const registry = new HttpEscalationRegistry();
    const onEscalate = registry.createOnEscalate({ page: fakePage(), logger: fakeLogger(), runId: "run-1", capability: "Open Sub-Account" });

    let settled = false;
    const promise = onEscalate({ step: STEP, stepNum: 10, reason: "unexpected interstitial" }).then((d) => {
      settled = true;
      return d;
    });

    await vi.waitFor(() => expect(registry.list()).toHaveLength(1)); // let the screenshot/logging microtasks flush
    expect(settled).toBe(false);
    expect(registry.list()[0].reason).toBe("unexpected interstitial");
    expect(registry.list()[0].capability).toBe("Open Sub-Account");

    const id = registry.list()[0].id;
    const resolved = registry.resolve(id, "resume");
    expect(resolved).toBe(true);
    expect(await promise).toBe("resume");
    expect(registry.list()).toHaveLength(0); // consumed, not left dangling
  });

  it("resolving an unknown id returns false and does not throw", () => {
    const registry = new HttpEscalationRegistry();
    expect(registry.resolve("not-a-real-id", "resume")).toBe(false);
  });

  it("an abort decision is delivered to the waiting caller, same as resume", async () => {
    const registry = new HttpEscalationRegistry();
    const onEscalate = registry.createOnEscalate({ page: fakePage(), logger: fakeLogger(), runId: "run-2", capability: "Open Sub-Account" });
    const promise = onEscalate({ step: STEP, stepNum: 10, reason: "x" });
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    registry.resolve(registry.list()[0].id, "abort");
    expect(await promise).toBe("abort");
  });

  it("two concurrent escalations (two different runs) are both listed independently", async () => {
    const registry = new HttpEscalationRegistry();
    const onEscalateA = registry.createOnEscalate({ page: fakePage(), logger: fakeLogger(), runId: "run-a", capability: "A" });
    const onEscalateB = registry.createOnEscalate({ page: fakePage(), logger: fakeLogger(), runId: "run-b", capability: "B" });
    const pA = onEscalateA({ step: STEP, stepNum: 1, reason: "a" });
    const pB = onEscalateB({ step: STEP, stepNum: 1, reason: "b" });
    await vi.waitFor(() => expect(registry.list()).toHaveLength(2));
    const idA = registry.list().find((i) => i.capability === "A")!.id;
    const idB = registry.list().find((i) => i.capability === "B")!.id;

    registry.resolve(idA, "resume");
    registry.resolve(idB, "abort");
    expect(await pA).toBe("resume");
    expect(await pB).toBe("abort");
  });

  it("times out to 'abort' if nobody resolves it in time, and removes itself from the pending list", async () => {
    vi.useFakeTimers();
    try {
      const registry = new HttpEscalationRegistry(5000);
      const onEscalate = registry.createOnEscalate({ page: fakePage(), logger: fakeLogger(), runId: "run-3", capability: "A" });
      const promise = onEscalate({ step: STEP, stepNum: 1, reason: "x" });
      await vi.advanceTimersByTimeAsync(0); // flush the screenshot microtask before the timer starts counting
      expect(registry.list()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(await promise).toBe("abort");
      expect(registry.list()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getScreenshotPath returns the path for a pending intervention, undefined otherwise", async () => {
    const registry = new HttpEscalationRegistry();
    const onEscalate = registry.createOnEscalate({ page: fakePage(), logger: fakeLogger(), runId: "run-4", capability: "A" });
    void onEscalate({ step: STEP, stepNum: 1, reason: "x" });
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    const id = registry.list()[0].id;
    expect(registry.getScreenshotPath(id)).toContain("intervention-1.png");
    expect(registry.getScreenshotPath("nope")).toBeUndefined();
  });
});
