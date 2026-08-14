import type { DiscoveryResult } from "../agent/types.js";
import type {
  ArtifactStep,
  CapabilityArtifact,
  Checkpoint,
  InputParam,
  KnownOutcome,
  OutputField,
  StepInput,
} from "./schema.js";

/**
 * Maps a specific (role, name) element -- as seen during discovery -- onto a named,
 * typed capability input. This is intentionally a small, human-authored table rather
 * than an LLM-generalization pass: for a thin-but-real recorder, an explicit mapping is
 * simpler, deterministic, and just as reviewable as an inferred one. See REPORT.md "Cuts".
 */
export interface ParamMapping {
  role: string;
  name: string;
  paramName: string;
  type: "string" | "number" | "boolean";
  sensitive?: boolean;
  description?: string;
}

export interface RecorderOptions {
  id: string;
  name: string;
  description: string;
  version: string;
  appId: string;
  baseUrlPattern: string;
  paramMappings: ParamMapping[];
  successCheckpoint: Checkpoint;
  /**
   * Known error/exceptional states for this target app. Not mined from the (happy-path)
   * discovery trace -- authored from domain knowledge of the app, the same way a human
   * reviewer would annotate a capability before approving it for unattended replay.
   */
  knownOutcomes: KnownOutcome[];
}

/** Post-processing helper: attach a checkpoint to the first step matching a predicate.
 *  Matching on step content (not a guessed step index) keeps this robust to the discovery
 *  agent taking a slightly different number/order of steps to reach the same milestone. */
export function attachStepCheckpoint(
  artifact: CapabilityArtifact,
  predicate: (step: ArtifactStep) => boolean,
  checkpoint: Checkpoint
): void {
  const step = artifact.steps.find(predicate);
  if (step) step.checkpoint = checkpoint;
}

export function buildArtifact(discovery: DiscoveryResult, options: RecorderOptions): CapabilityArtifact {
  if (discovery.status !== "finished") {
    throw new Error(`Cannot record an artifact from a discovery run with status "${discovery.status}" (expected "finished")`);
  }

  const inputParams: InputParam[] = [];
  const seenParamNames = new Set<string>();
  const outputSchema: OutputField[] = [];
  const steps: ArtifactStep[] = [];

  let stepSeq = 0;
  for (const discoveryStep of discovery.steps) {
    const action = discoveryStep.action;
    if (!action) continue; // control tool calls (finish/escalate) aren't executable steps

    stepSeq += 1;
    const stepId = `step-${stepSeq}`;
    const risk = discoveryStep.risk ?? "safe";
    const waitPolicy = { timeoutMs: 5000, retries: action.type === "click" ? 1 : 0 };

    if (action.type === "navigate") {
      steps.push({ id: stepId, actionType: "navigate", description: `Navigate to ${action.url}`, url: action.url, risk, waitPolicy });
      continue;
    }

    const targetRole = String(discoveryStep.toolInput.role ?? "");
    const targetName = String(discoveryStep.toolInput.name ?? "");
    const mapping = options.paramMappings.find((m) => m.role === targetRole && m.name === targetName);

    if (mapping && !seenParamNames.has(mapping.paramName)) {
      seenParamNames.add(mapping.paramName);
      inputParams.push({
        name: mapping.paramName,
        type: mapping.type,
        required: true,
        sensitive: mapping.sensitive ?? false,
        description: mapping.description,
      });
    }

    if (action.type === "click") {
      steps.push({
        id: stepId,
        actionType: "click",
        description: `Click ${targetRole} "${targetName}"`,
        locator: action.target,
        risk,
        waitPolicy,
      });
    } else if (action.type === "type") {
      const input: StepInput = mapping ? { paramRef: mapping.paramName } : { literal: action.text };
      steps.push({
        id: stepId,
        actionType: "type",
        description: `Type into ${targetRole} "${targetName}"`,
        locator: action.target,
        input,
        risk,
        waitPolicy,
      });
    } else if (action.type === "select_option") {
      const input: StepInput = mapping ? { paramRef: mapping.paramName } : { literal: action.option };
      steps.push({
        id: stepId,
        actionType: "select_option",
        description: `Select option on ${targetRole} "${targetName}"`,
        locator: action.target,
        input,
        risk,
        waitPolicy,
      });
    } else if (action.type === "extract") {
      const outputName = String(discoveryStep.toolInput.as ?? `output_${stepSeq}`);
      outputSchema.push({
        name: outputName,
        type: "string",
        sourceStepId: stepId,
        description: `Extracted from ${targetRole} "${targetName}"`,
      });
      steps.push({
        id: stepId,
        actionType: "extract",
        description: `Extract value from ${targetRole} "${targetName}"`,
        locator: action.target,
        outputName,
        risk,
        waitPolicy,
      });
    }
  }

  return {
    id: options.id,
    name: options.name,
    description: options.description,
    version: options.version,
    createdAt: new Date().toISOString(),
    target: { appId: options.appId, surfaceType: "web", baseUrlPattern: options.baseUrlPattern },
    inputParams,
    outputSchema,
    steps,
    successCheckpoint: options.successCheckpoint,
    knownOutcomes: options.knownOutcomes,
  };
}
