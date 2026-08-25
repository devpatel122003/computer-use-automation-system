import type { ArtifactStep, CapabilityArtifact, KnownOutcome, StepInput } from "../artifact/schema.js";
import type { Action, ActionResult, Surface } from "../surface/types.js";
import type { GuardrailsPolicy } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { evaluateCheckpoint } from "./checkpoint.js";
import { attemptAssistedRecovery, type AssistedRecoveryConfig } from "./assisted-recovery.js";
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
  /** Brief §8 "Assisted fallback", opt-in only: when set, a step whose mechanical action
   *  fails with no known outcome to explain it gets exactly one bounded, policy-checked LLM
   *  recovery attempt before this reports a hard failure. Omitted by default everywhere --
   *  replay's core promise ("never calls a model") holds unless a caller explicitly opts in
   *  here (see src/cli/replay.ts's `--assisted-recovery` flag). */
  assistedRecovery?: AssistedRecoveryConfig;
}

/** A step is retried after recovery at most once -- if the same condition recurs
 *  immediately (e.g. the session times out again right after re-authenticating), that's a
 *  systemic problem recovery can't paper over, and we should hard-fail rather than loop. */
const MAX_RECOVERY_ATTEMPTS_PER_STEP = 1;

function substituteTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(.+?)\}/g, (_match, name: string) => params[name] ?? "");
}

function resolveInput(input: StepInput | undefined, params: Record<string, string>): string {
  if (!input) return "";
  if ("literal" in input) return input.literal;
  return params[input.paramRef] ?? "";
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function buildAction(step: ArtifactStep, params: Record<string, string>, baseUrlPattern: string): Action {
  switch (step.actionType) {
    case "navigate": {
      const path = substituteTemplate(step.url ?? "", params);
      return { type: "navigate", url: isAbsoluteUrl(path) ? path : `${baseUrlPattern}${path}` };
    }
    case "click":
      return { type: "click", target: step.locator ?? [], timeoutMs: step.waitPolicy.timeoutMs };
    case "type":
      return { type: "type", target: step.locator ?? [], text: resolveInput(step.input, params), timeoutMs: step.waitPolicy.timeoutMs };
    case "select_option":
      return {
        type: "select_option",
        target: step.locator ?? [],
        option: resolveInput(step.input, params),
        timeoutMs: step.waitPolicy.timeoutMs,
      };
    case "extract":
      return { type: "extract", target: step.locator ?? [] };
    default:
      throw new Error(`Unhandled action type: ${step.actionType}`);
  }
}

function validateParams(artifact: CapabilityArtifact, params: Record<string, string>): void {
  // Empty string counts as missing, not "provided" -- a blank operator ID or member ID is
  // never a legitimate value in this domain. Found for real while wiring the conversational
  // front end (src/frontend/planner.ts): a model that omits a value it isn't sure of can
  // still supply "" for a plain (non-sensitive) required field, which used to sail through
  // this check and only fail once the browser hit a login page it couldn't actually use.
  const missing = artifact.inputParams.filter((p) => p.required && (params[p.name] === undefined || params[p.name] === ""));
  if (missing.length > 0) {
    throw new Error(`Missing required input params: ${missing.map((p) => p.name).join(", ")}`);
  }

  const typeErrors: string[] = [];
  for (const param of artifact.inputParams) {
    const value = params[param.name];
    if (value === undefined) continue;
    if (param.type === "number" && Number.isNaN(Number(value))) {
      typeErrors.push(`"${param.name}" is declared type "number" but got "${value}"`);
    }
    if (param.type === "boolean" && value !== "true" && value !== "false") {
      typeErrors.push(`"${param.name}" is declared type "boolean" but got "${value}" (expected "true"/"false")`);
    }
  }
  if (typeErrors.length > 0) {
    throw new Error(`Invalid input params: ${typeErrors.join("; ")}`);
  }
}

interface ReplayContext {
  artifact: CapabilityArtifact;
  params: Record<string, string>;
  surface: Surface;
  policy: GuardrailsPolicy;
  logger: EvidenceLogger;
  runId: string;
  allowRisky: boolean;
  onRiskyStep?: (ctx: { step: ArtifactStep }) => Promise<boolean>;
  assistedRecovery?: AssistedRecoveryConfig;
}

type StepOutcome = { outcome: "success"; extracted?: { name: string; value: string } } | { outcome: "failure"; result: ReplayResult };

/** Guardrail gate shared by every action execution site (main loop, recovery steps, and
 *  post-recovery retries) -- previously only the main loop's first attempt went through
 *  this, so a recovered retry of a risky step (e.g. re-submitting the POST that opens a
 *  sub-account) could fire with zero authorization check and no second confirmation. */
async function authorizeAndConfirm(
  ctx: ReplayContext,
  action: Action,
  step: ArtifactStep,
  stepNum: number
): Promise<{ ok: true } | { ok: false; result: ReplayResult }> {
  const authorization = await ctx.policy.authorize(ctx.surface, action);
  if (!authorization.allowed) {
    const evidenceRef = await ctx.surface.screenshot(`blocked-${step.id}`);
    ctx.logger.log({
      step: stepNum,
      phase: "error",
      summary: `Blocked by guardrails at ${step.id}: ${authorization.reason}`,
      detail: { authorization },
    });
    return {
      ok: false,
      result: {
        status: "failure",
        runId: ctx.runId,
        stepId: step.id,
        expected: "action within allowlist",
        observed: authorization.reason ?? "blocked",
        evidenceRef,
      },
    };
  }

  if (authorization.risk === "risky" && !ctx.allowRisky) {
    const proceed = ctx.onRiskyStep ? await ctx.onRiskyStep({ step }) : false;
    if (!proceed) {
      const evidenceRef = await ctx.surface.screenshot(`risky-unconfirmed-${step.id}`);
      ctx.logger.log({ step: stepNum, phase: "escalation", summary: `Risky step ${step.id} requires confirmation; none given.` });
      return {
        ok: false,
        result: {
          status: "failure",
          runId: ctx.runId,
          stepId: step.id,
          expected: "confirmation to proceed with risky step",
          observed: "no confirmation given (pass --allow-risky or confirm interactively)",
          evidenceRef,
        },
      };
    }
  }

  return { ok: true };
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

/** Re-runs a fixed sequence of prior steps (e.g. login) to recover a lost session, no LLM
 *  involved. Each recovery action goes through the same guardrail gate as everything else
 *  (C3 fix) -- recovery is not a bypass. */
async function runRecoverySteps(ctx: ReplayContext, stepIds: string[]): Promise<boolean> {
  for (const stepId of stepIds) {
    const step = ctx.artifact.steps.find((s) => s.id === stepId);
    if (!step) {
      ctx.logger.log({ step: 0, phase: "error", summary: `Recovery step "${stepId}" does not exist in this artifact.` });
      return false;
    }
    const action = buildAction(step, ctx.params, ctx.artifact.target.baseUrlPattern);

    const authorization = await authorizeAndConfirm(ctx, action, step, 0);
    if (!authorization.ok) {
      ctx.logger.log({ step: 0, phase: "error", summary: `Recovery step "${stepId}" was not authorized; aborting recovery.` });
      return false;
    }

    const result = await ctx.surface.perform(action);
    ctx.logger.log({
      step: 0,
      phase: "act",
      summary: `Recovery re-ran ${step.id} (${step.actionType}): ${result.ok ? "ok" : `failed (${result.error})`}`,
      detail: { stepId: step.id, result },
    });
    if (!result.ok) return false;
  }
  return true;
}

async function handleOutcome(ctx: ReplayContext, outcome: KnownOutcome, stepId: string): Promise<{ recovered: boolean; result?: ReplayResult }> {
  ctx.logger.log({ step: 0, phase: "outcome", summary: `Detected known outcome "${outcome.name}" (${outcome.category})`, detail: { outcome } });

  if (outcome.category === "business_outcome") {
    // A business outcome is a normal, reportable result -- but a caller debugging "did we
    // correctly land on X" still benefits from a visual record, and previously nothing was
    // captured here at all.
    const evidenceRef = await ctx.surface.screenshot(`outcome-${outcome.name}`);
    return {
      recovered: false,
      result: { status: "business_outcome", runId: ctx.runId, outcome: outcome.name, description: outcome.description, stepId, evidenceRef },
    };
  }

  if (outcome.category === "recoverable") {
    if (outcome.recovery === "reauthenticate_and_retry_step" && outcome.recoveryStepIds) {
      const recovered = await runRecoverySteps(ctx, outcome.recoveryStepIds);
      return { recovered };
    }
    if (outcome.recovery === "retry_step") {
      // No prior steps to replay first -- just signal "try the same action again."
      return { recovered: true };
    }
  }

  // "hard_failure" category, or a recoverable outcome with no recovery procedure we know
  // how to execute: surface it as a failure rather than silently treating it as handled.
  const evidenceRef = await ctx.surface.screenshot(`outcome-${outcome.name}`);
  return {
    recovered: false,
    result: {
      status: "failure",
      runId: ctx.runId,
      stepId,
      expected: "no known error state",
      observed: `${outcome.name}: ${outcome.description}`,
      evidenceRef,
    },
  };
}

/** Executes one step end to end: authorize -> act (with wait-policy retries) -> on failure,
 *  try known-outcome recovery -> on success, verify the checkpoint -> on checkpoint
 *  failure, also try recovery. Recovering from EITHER failure mode retries via a recursive
 *  call to this same function, so a post-recovery retry gets full re-verification
 *  (re-authorized, checkpoint re-checked, output re-captured) instead of a shortcut that
 *  skips them -- previously the action-failure path's retry skipped both. */
async function executeStep(ctx: ReplayContext, step: ArtifactStep, stepNum: number, recoveryAttempt = 0): Promise<StepOutcome> {
  const action = buildAction(step, ctx.params, ctx.artifact.target.baseUrlPattern);

  const authorization = await authorizeAndConfirm(ctx, action, step, stepNum);
  if (!authorization.ok) return { outcome: "failure", result: authorization.result };

  let attempt = 0;
  let result: ActionResult = await ctx.surface.perform(action);
  while (!result.ok && attempt < step.waitPolicy.retries) {
    attempt += 1;
    ctx.logger.log({ step: stepNum, phase: "act", summary: `Retry ${attempt} for ${step.id} after: ${result.error}` });
    result = await ctx.surface.perform(action);
  }

  ctx.logger.log({
    step: stepNum,
    phase: "act",
    summary: `Performed ${step.actionType} (${step.id}): ${result.ok ? "ok" : `failed (${result.error})`}`,
    detail: { action, result },
  });

  const canRecover = recoveryAttempt < MAX_RECOVERY_ATTEMPTS_PER_STEP;
  let assistedRecoverySucceeded = false;

  if (!result.ok) {
    if (canRecover) {
      const outcome = await detectKnownOutcome(ctx.surface, ctx.artifact.knownOutcomes, ctx.params);
      if (outcome) {
        const handled = await handleOutcome(ctx, outcome, step.id);
        if (handled.recovered) return executeStep(ctx, step, stepNum, recoveryAttempt + 1);
        if (handled.result) return { outcome: "failure", result: handled.result };
      }
    }

    // Brief §8 "Assisted fallback" (opt-in only -- see ReplayOptions.assistedRecovery):
    // one bounded LLM call proposing a single corrective action, only for a mechanical
    // action failure with no known outcome to explain it, and never for an "extract" step
    // (the recovery tool vocabulary is click/type/select_option -- there's no sensible
    // single one of those that recovers a failed data extraction). Deliberately not wired
    // into the checkpoint-failure branch below: "the action nominally succeeded but the
    // resulting page doesn't match" is a fuzzier signal to hand a model than "this element
    // didn't resolve at all," and this is a first, narrow pass at the stretch goal, not the
    // whole surface it could eventually cover.
    if (canRecover && ctx.assistedRecovery && step.actionType !== "extract") {
      const assisted = await attemptAssistedRecovery({
        config: ctx.assistedRecovery,
        surface: ctx.surface,
        policy: ctx.policy,
        logger: ctx.logger,
        step,
        stepNum,
        failureContext: result.error ?? "action did not resolve or execute",
        onRiskyStep: ctx.onRiskyStep,
      });
      if (assisted.recovered) {
        assistedRecoverySucceeded = true;
        result = { ok: true, url: ctx.surface.currentUrl() };
      }
    }

    if (!assistedRecoverySucceeded) {
      const evidenceRef = await ctx.surface.screenshot(`failure-${step.id}`);
      ctx.logger.log({ step: stepNum, phase: "error", summary: `Hard failure at ${step.id}: ${result.error}` });
      return {
        outcome: "failure",
        result: { status: "failure", runId: ctx.runId, stepId: step.id, expected: `${step.actionType} to succeed`, observed: result.error ?? "unknown error", evidenceRef },
      };
    }
  }

  // Verify we actually landed somewhere in-allowlist, not just that the pre-flight
  // prediction was fine -- a server redirect can land outside what was predicted (also
  // checked after a successful assisted-recovery action, since that's a real navigation
  // too, just not one `action.type` reflects).
  if (action.type === "navigate" || action.type === "click" || assistedRecoverySucceeded) {
    const landed = ctx.policy.authorizeLandedUrl(ctx.surface.currentUrl());
    if (!landed.allowed) {
      const evidenceRef = await ctx.surface.screenshot(`landed-outside-allowlist-${step.id}`);
      ctx.logger.log({ step: stepNum, phase: "error", summary: `Landed outside allowlist after ${step.id}: ${landed.reason}`, detail: { landed } });
      return {
        outcome: "failure",
        result: { status: "failure", runId: ctx.runId, stepId: step.id, expected: "landed URL within allowlist", observed: landed.reason ?? "blocked", evidenceRef },
      };
    }
  }

  let extracted: { name: string; value: string } | undefined;
  if (step.actionType === "extract" && result.extractedValue !== undefined && step.outputName) {
    extracted = { name: step.outputName, value: result.extractedValue };
  }

  if (step.checkpoint) {
    const checkpointOk = await evaluateCheckpoint(ctx.surface, step.checkpoint, ctx.params);
    ctx.logger.log({
      step: stepNum,
      phase: "checkpoint",
      summary: `Checkpoint for ${step.id}: ${checkpointOk ? "passed" : "failed"}`,
      detail: { checkpoint: step.checkpoint },
    });

    if (!checkpointOk) {
      if (canRecover) {
        const outcome = await detectKnownOutcome(ctx.surface, ctx.artifact.knownOutcomes, ctx.params);
        if (outcome) {
          const handled = await handleOutcome(ctx, outcome, step.id);
          if (handled.recovered) return executeStep(ctx, step, stepNum, recoveryAttempt + 1);
          if (handled.result) return { outcome: "failure", result: handled.result };
        }
      }
      const evidenceRef = await ctx.surface.screenshot(`checkpoint-failed-${step.id}`);
      return {
        outcome: "failure",
        result: {
          status: "failure",
          runId: ctx.runId,
          stepId: step.id,
          expected: step.checkpoint.description,
          observed: `url=${ctx.surface.currentUrl()}`,
          evidenceRef,
        },
      };
    }
  }

  return { outcome: "success", extracted };
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

  const ctx: ReplayContext = {
    artifact,
    params,
    surface,
    policy,
    logger,
    runId,
    allowRisky: options.allowRisky ?? false,
    onRiskyStep: options.onRiskyStep,
    assistedRecovery: options.assistedRecovery,
  };

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

    const stepResult = await executeStep(ctx, step, stepNum);
    if (stepResult.outcome === "failure") return stepResult.result;
    if (stepResult.extracted) outputs[stepResult.extracted.name] = stepResult.extracted.value;
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
      const handled = await handleOutcome(ctx, outcome, "success_checkpoint");
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
