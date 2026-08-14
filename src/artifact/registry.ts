import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CapabilityArtifact } from "./schema.js";

/**
 * Stretch goal (Section 8, "Confidence & approval"): score artifacts by how reliably
 * they replay, and gate unattended replay on an approval state (draft -> approved).
 *
 * Kept separate from the artifact schema itself: the artifact is a reviewable contract
 * (steps/params/outputs), while approval state and replay history are mutable operational
 * data about a *specific recorded version* of that contract -- closer to telemetry than to
 * the capability definition. Keying by a content fingerprint (not just id+version) means a
 * re-recorded artifact with materially different steps starts back at "draft"/unproven
 * automatically, rather than silently inheriting a prior approval it never earned.
 */

export type ApprovalState = "draft" | "approved";
export type ReplayOutcomeStatus = "success" | "business_outcome" | "failure";

export interface ReplayHistoryEntry {
  runId: string;
  timestamp: string;
  status: ReplayOutcomeStatus;
}

export interface ArtifactRegistryEntry {
  artifactId: string;
  version: string;
  fingerprint: string;
  approvalState: ApprovalState;
  history: ReplayHistoryEntry[];
}

export interface ConfidenceScore {
  totalRuns: number;
  successCount: number;
  hardFailureCount: number;
  /** (success + business_outcome) / total -- both mean the artifact behaved correctly;
   *  only a hard failure means the replay engine couldn't explain what happened. */
  score: number;
  label: "unproven" | "low" | "medium" | "high";
}

const MAX_HISTORY = 50;

/** Stable content fingerprint -- excludes cosmetic/timestamp fields so identical recorded
 *  flows share history even if re-recorded, but a materially different flow does not. */
export function fingerprintArtifact(artifact: CapabilityArtifact): string {
  const stable = {
    id: artifact.id,
    target: artifact.target,
    inputParams: artifact.inputParams,
    outputSchema: artifact.outputSchema,
    steps: artifact.steps,
    successCheckpoint: artifact.successCheckpoint,
    knownOutcomes: artifact.knownOutcomes,
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

export type Registry = Record<string, ArtifactRegistryEntry>;

function registryKey(artifactId: string, fingerprint: string): string {
  return `${artifactId}@${fingerprint}`;
}

export function loadRegistry(registryPath: string): Registry {
  if (!fs.existsSync(registryPath)) return {};
  return JSON.parse(fs.readFileSync(registryPath, "utf-8")) as Registry;
}

export function saveRegistry(registryPath: string, registry: Registry): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/** Returns the entry for this exact artifact content, creating a fresh "draft" one if this
 *  content has never been seen before. Does not save -- caller decides when to persist. */
export function getOrCreateEntry(registry: Registry, artifact: CapabilityArtifact): ArtifactRegistryEntry {
  const fingerprint = fingerprintArtifact(artifact);
  const key = registryKey(artifact.id, fingerprint);
  const existing = registry[key];
  if (existing) return existing;

  const created: ArtifactRegistryEntry = {
    artifactId: artifact.id,
    version: artifact.version,
    fingerprint,
    approvalState: "draft",
    history: [],
  };
  registry[key] = created;
  return created;
}

export function recordReplayOutcome(entry: ArtifactRegistryEntry, outcome: ReplayHistoryEntry): void {
  entry.history.push(outcome);
  if (entry.history.length > MAX_HISTORY) {
    entry.history.splice(0, entry.history.length - MAX_HISTORY);
  }
}

export function setApprovalState(entry: ArtifactRegistryEntry, state: ApprovalState): void {
  entry.approvalState = state;
}

export function computeConfidence(entry: ArtifactRegistryEntry): ConfidenceScore {
  const totalRuns = entry.history.length;
  const hardFailureCount = entry.history.filter((h) => h.status === "failure").length;
  const successCount = totalRuns - hardFailureCount;
  const score = totalRuns === 0 ? 0 : successCount / totalRuns;

  let label: ConfidenceScore["label"] = "unproven";
  if (totalRuns > 0) {
    if (totalRuns >= 5 && score >= 0.95) label = "high";
    else if (score >= 0.7) label = "medium";
    else label = "low";
  }

  return { totalRuns, successCount, hardFailureCount, score, label };
}
