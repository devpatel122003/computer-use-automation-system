import { describe, expect, it } from "vitest";
import { computeConfidence, fingerprintArtifact, getOrCreateEntry, recordReplayOutcome, type Registry } from "./registry.js";
import type { CapabilityArtifact } from "./schema.js";

function makeArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return {
    id: "test-capability",
    name: "Test Capability",
    description: "d",
    version: "1.0.0",
    createdAt: "2026-01-01T00:00:00.000Z",
    target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputSchema: [],
    steps: [{ id: "step-1", actionType: "navigate", description: "Navigate", url: "http://localhost:4000/login", risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 } }],
    successCheckpoint: { kind: "text_match", expr: "OK", description: "" },
    knownOutcomes: [],
    ...overrides,
  };
}

describe("fingerprintArtifact", () => {
  it("is stable across identical content even with a different createdAt", () => {
    const a = makeArtifact({ createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeArtifact({ createdAt: "2026-06-01T00:00:00.000Z" });
    expect(fingerprintArtifact(a)).toBe(fingerprintArtifact(b));
  });

  it("changes when the steps change materially", () => {
    const a = makeArtifact();
    const b = makeArtifact({
      steps: [{ id: "step-1", actionType: "navigate", description: "Navigate", url: "http://localhost:4000/other", risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 } }],
    });
    expect(fingerprintArtifact(a)).not.toBe(fingerprintArtifact(b));
  });

  it("is stable across different object key insertion order for identical data", () => {
    // Regression test: a hand-built artifact (recorder output) and the same data rebuilt
    // by zod's `.parse()` (which reorders keys to schema declaration order) previously
    // produced two different fingerprints for byte-for-byte identical content, because
    // fingerprintArtifact hashed `JSON.stringify` with no key canonicalization.
    const step1 = { id: "step-1", actionType: "navigate" as const, description: "Navigate", url: "http://localhost:4000/login", risk: "safe" as const, waitPolicy: { timeoutMs: 5000, retries: 0 } };
    // Same fields, deliberately reinserted in a different order.
    const step1Reordered = {
      waitPolicy: step1.waitPolicy,
      risk: step1.risk,
      url: step1.url,
      description: step1.description,
      actionType: step1.actionType,
      id: step1.id,
    };
    const a = makeArtifact({ steps: [step1] });
    const b = makeArtifact({ steps: [step1Reordered as typeof step1] });
    expect(fingerprintArtifact(a)).toBe(fingerprintArtifact(b));
  });

  it("does not change when only target.baseUrlPattern changes (tenant/environment swap)", () => {
    // A capability re-pointed at a different tenant's base URL is still the same reviewed
    // flow -- it shouldn't lose its accumulated confidence/approval history.
    const a = makeArtifact({ target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://tenant-a.example.com" } });
    const b = makeArtifact({ target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://tenant-b.example.com" } });
    expect(fingerprintArtifact(a)).toBe(fingerprintArtifact(b));
  });
});

describe("getOrCreateEntry", () => {
  it("creates a fresh draft entry for content never seen before", () => {
    const registry: Registry = {};
    const entry = getOrCreateEntry(registry, makeArtifact());
    expect(entry.approvalState).toBe("draft");
    expect(entry.history).toEqual([]);
  });

  it("returns the SAME entry (and preserves history/approval) for identical content", () => {
    const registry: Registry = {};
    const first = getOrCreateEntry(registry, makeArtifact());
    first.approvalState = "approved";
    recordReplayOutcome(first, { runId: "r1", timestamp: "t", status: "success" });

    const second = getOrCreateEntry(registry, makeArtifact({ createdAt: "2026-12-31T00:00:00.000Z" }));
    expect(second.approvalState).toBe("approved");
    expect(second.history).toHaveLength(1);
  });

  it("starts a materially different artifact back at draft, not inheriting prior approval", () => {
    const registry: Registry = {};
    const first = getOrCreateEntry(registry, makeArtifact());
    first.approvalState = "approved";

    const differentContent = makeArtifact({
      steps: [{ id: "step-1", actionType: "navigate", description: "Navigate", url: "http://localhost:4000/changed", risk: "safe", waitPolicy: { timeoutMs: 5000, retries: 0 } }],
    });
    const second = getOrCreateEntry(registry, differentContent);
    expect(second.approvalState).toBe("draft");
  });
});

describe("computeConfidence", () => {
  it("reports unproven with zero history", () => {
    const registry: Registry = {};
    const entry = getOrCreateEntry(registry, makeArtifact());
    expect(computeConfidence(entry)).toEqual({ totalRuns: 0, successCount: 0, hardFailureCount: 0, score: 0, label: "unproven" });
  });

  it("counts business_outcome as clean, not a failure", () => {
    const registry: Registry = {};
    const entry = getOrCreateEntry(registry, makeArtifact());
    recordReplayOutcome(entry, { runId: "r1", timestamp: "t", status: "business_outcome" });
    const confidence = computeConfidence(entry);
    expect(confidence.successCount).toBe(1);
    expect(confidence.hardFailureCount).toBe(0);
    expect(confidence.score).toBe(1);
  });

  it("requires >=5 runs AND >=0.95 score for a 'high' label", () => {
    const registry: Registry = {};
    const entry = getOrCreateEntry(registry, makeArtifact());
    for (let i = 0; i < 4; i++) recordReplayOutcome(entry, { runId: `r${i}`, timestamp: "t", status: "success" });
    expect(computeConfidence(entry).label).toBe("medium"); // only 4 clean runs, not enough for "high" yet
    recordReplayOutcome(entry, { runId: "r5", timestamp: "t", status: "success" });
    expect(computeConfidence(entry).label).toBe("high");
  });

  it("drops to 'low' once failures push the score under 0.7", () => {
    const registry: Registry = {};
    const entry = getOrCreateEntry(registry, makeArtifact());
    recordReplayOutcome(entry, { runId: "r1", timestamp: "t", status: "success" });
    recordReplayOutcome(entry, { runId: "r2", timestamp: "t", status: "failure" });
    recordReplayOutcome(entry, { runId: "r3", timestamp: "t", status: "failure" });
    const confidence = computeConfidence(entry);
    expect(confidence.score).toBeCloseTo(1 / 3);
    expect(confidence.label).toBe("low");
  });
});
