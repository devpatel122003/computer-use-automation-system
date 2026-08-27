import { vi } from "vitest";
import type { Response } from "express";
import type { EvidenceLogger } from "../evidence/logger.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../artifact/schema.js";

/**
 * A handful of test doubles that were byte-for-byte identical across multiple test files
 * (verified by direct comparison, not just similar names) -- shared here instead of
 * reimplemented per file. Deliberately does NOT include `fakeSurface`/`fakePolicy`/
 * `makeArtifact`/`baseArtifact`-style helpers that exist in several test files under
 * similar names: those differ meaningfully from file to file (different signatures,
 * different stubbed behavior for that file's own scenarios), so unifying them would force
 * a lossy, over-generalized shape onto tests that don't actually share logic -- just a
 * naming convention.
 */

export function fakeLogger(): EvidenceLogger {
  return {
    log: () => undefined,
    addSensitiveKeys: () => undefined,
    addSensitiveValue: () => undefined,
    writeJson: () => "",
  } as unknown as EvidenceLogger;
}

export function fakeRes(): Response & { statusCode?: number; body?: unknown } {
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

/** A minimal, valid "open-sub-account"-shaped artifact -- shared by the two test files that
 *  both needed a base artifact to layer tenant/catalog behavior on top of, and were
 *  otherwise typing out an identical fixture. */
export function baseArtifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    id: "open-sub-account",
    name: "Open Sub-Account",
    description: "test",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputSchema: [],
    steps: [
      {
        id: "step-4",
        actionType: "click",
        description: 'Click button "Sign On"',
        locator: [{ strategy: "role", role: "button", name: "Sign On", nth: 0, confidence: "high", rationale: "r" }],
        risk: "safe",
        waitPolicy: { timeoutMs: 5000, retries: 0 },
      },
    ],
    successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
    knownOutcomes: [],
  });
}
