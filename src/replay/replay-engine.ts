import type { ArtifactStep, CapabilityArtifact, KnownOutcome, StepInput } from "../artifact/schema.js";
import type { Action, Surface } from "../surface/types.js";
import type { GuardrailsPolicy } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { evaluateCheckpoint } from "./checkpoint.js";
import type { ReplayResult } from "./types.js";

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  params: Record<string, string>;
  surface: Surface;
  policy: GuardrailsPolicy;
  logger: EvidenceLogger;
  runId: string;
  /** Unattended production replay of risky steps requires an explicit opt-in. */
  allowRisky?: boolean;
  onRiskyStep?: (ctx: { step: ArtifactStep }) => Promise<boolean>;
}

function substituteTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(.+?)\}/g, (_match, name: string) => params[name] ?? "");
}

function resolveInput(input: StepInput | undefined, params: Record<string, string>): string {
  if (!input) return "";
  if ("literal" in input) return input.literal;
  return params[input.paramRef] ?? "";
}

function buildAction(step: ArtifactStep, params: Record<string, string>): Action {
  switch (step.actionType) {
    case "navigate":
      return { type: "navigate", url: substituteTemplate(step.url ?? "", params) };
    case "click":
      return { type: "click", target: step.locator ?? [] };
    case "type":
      return { type: "type", target: step.locator ?? [], text: resolveInput(step.input, params) };
    case "select_option":
      return { type: "select_option", target: step.locator ?? [], option: resolveInput(step.input, params) };
    case "extract":
      return { type: "extract", target: step.locator ?? [] };
    default:
      throw new Error(`Unhandled action type: ${step.actionType}`);
  }
}

function validateParams(artifact: CapabilityArtifact, params: Record<string, string>): void {
  const missing = artifact.inputParams.filter((p) => p.required && params[p.name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required input params: ${missing.map((p) => p.name).join(", ")}`);
  }
}

async function detectKnownOutcome(
  surface: Surface,
  knownOutcomes: KnownOutcome[],
  params: Record<string, string>
): Promise<KnownOutcome | undefined> {
  for (const outcome of knownOutcomes) {
    if (await evaluateCheckpoint(surface, outcome.detector, params)) {
      return outcome;
    }
  }
  return undefined;
}

/** Re-runs a fixed sequence of prior steps (e.g. login) to recover a lost session, no LLM involved. */
async function runRecoverySteps(
  artifact: CapabilityArtifact,
  stepIds: string[],
  surface: Surface,
  params: Record<string, string>,
  logger: EvidenceLogger
): Promise<boolean> {
  for (const stepId of stepIds) {
    const step = artifact.steps.find((s) => s.id === stepId);
    if (!step) return false;
    const result = await surface.perform(buildAction(step, params));
    logger.log({
      step: 0,
      phase: "act",
      summary: `Recovery re-ran ${step.id} (${step.actionType}): ${result.ok ? "ok" : `failed (${result.error})`}`,
      detail: { stepId: step.id, result },
    });
    if (!result.ok) return false;
  }
  return true;
}

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const { artifact, params, surface, policy, logger, runId } = options;
  validateParams(artifact, params);

  const sensitiveParams = artifact.inputParams.filter((p) => p.sensitive);
  logger.addSensitiveKeys(sensitiveParams.map((p) => p.name));
  for (const p of sensitiveParams) {
    const value = params[p.name];
    if (value) logger.addSensitiveValue(value);
  }

  logger.log({
    step: 0,
    phase: "start",
    summary: `Replay starting: ${artifact.name} v${artifact.version}`,
    detail: { artifactId: artifact.id, params },
  });

  const outputs: Record<string, string> = {};

  for (let i = 0; i < artifact.steps.length; i++) {
    const step = artifact.steps[i] as ArtifactStep;
    const stepNum = i + 1;
    const action = buildAction(step, params);

    const authorization = await policy.authorize(surface, action);
    if (!authorization.allowed) {
      const evidenceRef = await surface.screenshot(`blocked-${step.id}`);
      logger.log({
        step: stepNum,
        phase: "error",
        summary: `Blocked by guardrails at ${step.id}: ${authorization.reason}`,
        detail: { authorization },
      });
      return { status: "failure", runId, stepId: step.id, expected: "action within allowlist", observed: authorization.reason ?? "blocked", evidenceRef };
    }

    if (authorization.risk === "risky" && !options.allowRisky) {
      const proceed = options.onRiskyStep ? await options.onRiskyStep({ step }) : false;
      if (!proceed) {
        const evidenceRef = await surface.screenshot(`risky-unconfirmed-${step.id}`);
        logger.log({ step: stepNum, phase: "escalation", summary: `Risky step ${step.id} requires confirmation; none given.` });
        return {
          status: "failure",
          runId,
          stepId: step.id,
          expected: "confirmation to proceed with risky step",
          observed: "no confirmation given (pass --allow-risky or confirm interactively)",
          evidenceRef,
        };
      }
    }

    let attempt = 0;
    let result = await surface.perform(action);
    while (!result.ok && attempt < step.waitPolicy.retries) {
      attempt += 1;
      logger.log({ step: stepNum, phase: "act", summary: `Retry ${attempt} for ${step.id} after: ${result.error}` });
      result = await surface.perform(action);
    }

    logger.log({
      step: stepNum,
      phase: "act",
      summary: `Performed ${step.actionType} (${step.id}): ${result.ok ? "ok" : `failed (${result.error})`}`,
      detail: { action, result },
    });

    if (step.actionType === "extract" && result.ok && result.extractedValue !== undefined && step.outputName) {
      outputs[step.outputName] = result.extractedValue;
    }

    if (!result.ok) {
      const outcome = await detectKnownOutcome(surface, artifact.knownOutcomes, params);
      if (outcome) {
        const handled = await handleOutcome(outcome, artifact, surface, params, logger, runId, step.id);
        if (handled.recovered) {
          result = await surface.perform(action); // retry the step once, post-recovery
          logger.log({ step: stepNum, phase: "act", summary: `Post-recovery retry of ${step.id}: ${result.ok ? "ok" : `failed (${result.error})`}` });
          if (result.ok) continue;
        } else if (handled.result) {
          return handled.result;
        }
      }
      const evidenceRef = await surface.screenshot(`failure-${step.id}`);
      logger.log({ step: stepNum, phase: "error", summary: `Hard failure at ${step.id}: ${result.error}` });
      return { status: "failure", runId, stepId: step.id, expected: `${step.actionType} to succeed`, observed: result.error ?? "unknown error", evidenceRef };
    }

    if (step.checkpoint) {
      const checkpointOk = await evaluateCheckpoint(surface, step.checkpoint, params);
      logger.log({
        step: stepNum,
        phase: "checkpoint",
        summary: `Checkpoint for ${step.id}: ${checkpointOk ? "passed" : "failed"}`,
        detail: { checkpoint: step.checkpoint },
      });
      if (!checkpointOk) {
        const outcome = await detectKnownOutcome(surface, artifact.knownOutcomes, params);
        if (outcome) {
          const handled = await handleOutcome(outcome, artifact, surface, params, logger, runId, step.id);
          if (handled.recovered) {
            // Recovery (e.g. re-authenticating) can lose in-page state the step depended
            // on, so replay the step's own action once more before re-checking, not just
            // re-check blindly.
            const retryResult = await surface.perform(action);
            const retryCheckpointOk = retryResult.ok && (await evaluateCheckpoint(surface, step.checkpoint, params));
            logger.log({
              step: stepNum,
              phase: "checkpoint",
              summary: `Post-recovery retry of ${step.id}: ${retryCheckpointOk ? "passed" : "still failed"}`,
            });
            if (retryCheckpointOk) continue;
          } else if (handled.result) {
            return handled.result;
          }
        }
        const evidenceRef = await surface.screenshot(`checkpoint-failed-${step.id}`);
        return {
          status: "failure",
          runId,
          stepId: step.id,
          expected: step.checkpoint.description,
          observed: `url=${surface.currentUrl()}`,
          evidenceRef,
        };
      }
    }
  }

  const finalOk = await evaluateCheckpoint(surface, artifact.successCheckpoint, params);
  logger.log({
    step: artifact.steps.length + 1,
    phase: "checkpoint",
    summary: `Success checkpoint: ${finalOk ? "passed" : "failed"}`,
    detail: { checkpoint: artifact.successCheckpoint },
  });

  if (!finalOk) {
    const outcome = await detectKnownOutcome(surface, artifact.knownOutcomes, params);
    if (outcome) {
      const handled = await handleOutcome(outcome, artifact, surface, params, logger, runId, "success_checkpoint");
      if (handled.result) return handled.result;
    }
    const evidenceRef = await surface.screenshot("success-checkpoint-failed");
    return {
      status: "failure",
      runId,
      stepId: "success_checkpoint",
      expected: artifact.successCheckpoint.description,
      observed: `url=${surface.currentUrl()}`,
      evidenceRef,
    };
  }

  logger.log({ step: artifact.steps.length + 1, phase: "outcome", summary: "Replay succeeded", detail: { outputs } });
  return { status: "success", runId, outputs };
}

async function handleOutcome(
  outcome: KnownOutcome,
  artifact: CapabilityArtifact,
  surface: Surface,
  params: Record<string, string>,
  logger: EvidenceLogger,
  runId: string,
  stepId: string
): Promise<{ recovered: boolean; result?: ReplayResult }> {
  logger.log({ step: 0, phase: "outcome", summary: `Detected known outcome "${outcome.name}" (${outcome.category})`, detail: { outcome } });

  if (outcome.category === "business_outcome") {
    return { recovered: false, result: { status: "business_outcome", runId, outcome: outcome.name, description: outcome.description, stepId } };
  }

  if (outcome.category === "recoverable" && outcome.recovery === "reauthenticate_and_retry_step" && outcome.recoveryStepIds) {
    const recovered = await runRecoverySteps(artifact, outcome.recoveryStepIds, surface, params, logger);
    return { recovered };
  }

  // "hard_failure" category, or a recoverable outcome we don't know how to act on: surface it as a failure.
  const evidenceRef = await surface.screenshot(`outcome-${outcome.name}`);
  return {
    recovered: false,
    result: {
      status: "failure",
      runId,
      stepId,
      expected: "no known error state",
      observed: `${outcome.name}: ${outcome.description}`,
      evidenceRef,
    },
  };
}
