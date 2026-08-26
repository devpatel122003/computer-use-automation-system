import fs from "node:fs";
import { FunctionCallingConfigMode, Type, type FunctionDeclaration, type GoogleGenAI, type Part } from "@google/genai";
import type { ArtifactStep } from "../artifact/schema.js";
import type { Action, Surface } from "../surface/types.js";
import type { GuardrailsPolicy } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { findElement, formatObservation } from "../agent/observation-format.js";
import { resolveModelList, withModelFallback } from "../agent/model-retry.js";

/**
 * Brief §8 "Assisted fallback": on a genuine replay failure, one bounded, policy-checked
 * LLM call may propose a single corrective action -- never open-ended, never a loop, never
 * a second attempt. This is deliberately narrower than the discovery loop: no `navigate`
 * (recovery must not wander off the current page and invalidate the artifact's own
 * checkpoint), no `finish`/`escalate` (there's no multi-turn conversation to end), no
 * `extract` (recovery's job is getting past a blocked step, not harvesting data).
 *
 * Also carries the vision-grounded fallback (the brief's "native desktop application...
 * the only reliable surface is what a human operator sees and does" case): alongside the
 * DOM-based tools, the model is also given a screenshot and a `click_at_coordinates` tool,
 * for surfaces with no walkable accessibility info at all (canvas-rendered widgets, a
 * screen-shared legacy terminal). One call, one model, one choice between "target this by
 * role+name" or "target this by pixel coordinates" -- whichever the actual page supports.
 *
 * A proposed action classified `risky` by the guardrail policy is never auto-executed --
 * it goes through the exact same confirm-or-decline callback a normal risky step does
 * (`onRiskyStep`), declining by default if none is wired up (e.g. the unattended capability
 * API never passes one). This was a deliberate correction, not the original design: a
 * blanket "refuse anything risky" rule would make `click_at_coordinates` permanently inert,
 * since a coordinate click's destination is *always* unverifiable and therefore always
 * classified risky (see GuardrailsPolicy.authorize) -- treating that identically to "an
 * unattended write" rather than "an action nobody can pre-verify" was conflating two
 * different kinds of risk.
 *
 * Deliberately NOT built here: promoting a working assisted action into a new candidate
 * locator on the artifact itself. A single lucky model guess getting silently baked into a
 * production artifact is a real risk (see REPORT.md) that deserves human review as its own
 * step, not an automatic side effect of this one.
 */

export interface AssistedRecoveryConfig {
  genai: GoogleGenAI;
  /** Explicit single-model override (mainly for tests). Unset means "honor GEMINI_MODEL /
   *  GEMINI_FALLBACK_MODELS like every other real Gemini call in this repo" -- previously
   *  this hardcoded "gemini-3.7-flash" regardless of .env, a real inconsistency with
   *  discovery and the conversational front end, both of which already read GEMINI_MODEL. */
  model?: string;
}

export interface AssistedRecoveryOutcome {
  recovered: boolean;
  reasoning?: string;
  note: string;
}

const DOM_RECOVERY_TOOLS: FunctionDeclaration[] = (["click", "type", "select_option"] as const).map((name) => ({
  name,
  description: `Same as the recorded action type "${name}", but targeting whatever element on the CURRENT page actually resolves it, by accessible role+name.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      reasoning: { type: Type.STRING, description: "One sentence: why this action gets past the failure, given what's actually on the page now." },
      role: { type: Type.STRING, enum: ["button", "link", "textbox", "combobox", "checkbox", "radio"] },
      name: { type: Type.STRING },
      nth: { type: Type.INTEGER },
      ...(name === "type" ? { text: { type: Type.STRING } } : {}),
      ...(name === "select_option" ? { option: { type: Type.STRING } } : {}),
    },
    required: name === "type" ? ["reasoning", "role", "name", "text"] : name === "select_option" ? ["reasoning", "role", "name", "option"] : ["reasoning", "role", "name"],
  },
}));

const VISION_RECOVERY_TOOL: FunctionDeclaration = {
  name: "click_at_coordinates",
  description:
    "Click at a pixel coordinate in the attached screenshot. Use this ONLY when the target has no accessible role/name in the observation " +
    "(e.g. it's drawn on a <canvas> or otherwise has no DOM semantics) -- prefer click/type/select_option whenever the observation lists a usable element.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      reasoning: { type: Type.STRING, description: "One sentence: what you see at these coordinates in the screenshot, and why it satisfies the step." },
      x: { type: Type.INTEGER, description: "Pixel x-coordinate in the screenshot, left edge = 0." },
      y: { type: Type.INTEGER, description: "Pixel y-coordinate in the screenshot, top edge = 0." },
    },
    required: ["reasoning", "x", "y"],
  },
};

const SYSTEM_PROMPT = `You are a bounded, single-step recovery assistant for a deterministic replay engine.
A recorded step just failed to execute against the live page. You get exactly ONE proposed
action to get past it -- not to complete the rest of the goal, only this one step. Prefer
click, type, or select_option targeting an element actually visible in the current text
observation. Only use click_at_coordinates if the observation has no usable element for
this step -- for example the target is drawn on a canvas or is otherwise purely visual with
no accessible role/name -- in which case look at the attached screenshot instead. If
nothing could plausibly satisfy this step, still propose your best single guess; the caller
will verify it worked, not trust your judgment blindly.`;

function resolveRecoveryAction(
  toolName: string,
  input: Record<string, unknown>,
  snapshot: Parameters<typeof findElement>[0]
): { action?: Action; error?: string } {
  if (toolName === "click_at_coordinates") {
    const x = typeof input.x === "number" ? input.x : NaN;
    const y = typeof input.y === "number" ? input.y : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) return { error: `click_at_coordinates called with non-numeric x/y (${input.x}, ${input.y})` };
    return { action: { type: "click_coordinates", x, y } };
  }

  const role = input.role as string | undefined;
  const name = String(input.name ?? "");
  const nth = typeof input.nth === "number" ? input.nth : 0;
  const element = findElement(snapshot, { role, name, nth });
  if (!element) return { error: `No element found matching role=${role ?? "any"} name="${name}" nth=${nth}` };

  if (toolName === "click") return { action: { type: "click", target: element.locatorCandidates } };
  if (toolName === "type") return { action: { type: "type", target: element.locatorCandidates, text: String(input.text ?? "") } };
  if (toolName === "select_option") return { action: { type: "select_option", target: element.locatorCandidates, option: String(input.option ?? "") } };
  return { error: `Unknown recovery tool: ${toolName}` };
}

export async function attemptAssistedRecovery(params: {
  config: AssistedRecoveryConfig;
  surface: Surface;
  policy: GuardrailsPolicy;
  logger: EvidenceLogger;
  step: ArtifactStep;
  stepNum: number;
  failureContext: string;
  /** Same shape/contract as ReplayOptions.onRiskyStep: asked before executing a proposed
   *  action the guardrail policy classifies as risky. Declines by default (returns false)
   *  if omitted, same as the main replay path. */
  onRiskyStep?: (ctx: { step: ArtifactStep }) => Promise<boolean>;
}): Promise<AssistedRecoveryOutcome> {
  const { config, surface, policy, logger, step, stepNum, failureContext, onRiskyStep } = params;
  const models = config.model ? [config.model] : resolveModelList();

  const snapshot = await surface.observe();
  const screenshotPath = await surface.screenshot(`assisted-recovery-${step.id}`);
  const imagePart: Part = { inlineData: { mimeType: "image/png", data: fs.readFileSync(screenshotPath).toString("base64") } };

  let response;
  try {
    // Transient-failure resilience (src/agent/model-retry.ts), not a second recovery
    // attempt: retrying on a 429/503 blip is getting the ONE bounded attempt to actually
    // go through, not reasoning about the failure again. Hit for real, repeatedly, while
    // producing evidence for this exact module.
    response = await withModelFallback(
      models,
      (model) =>
        config.genai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                { text: `Step goal: ${step.description}\nWhat went wrong: ${failureContext}\n\nCurrent observation:\n${formatObservation(snapshot)}` },
                imagePart,
              ],
            },
          ],
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: [...DOM_RECOVERY_TOOLS, VISION_RECOVERY_TOOL] }],
            toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
          },
        }),
      logger
    );
  } catch (err) {
    // A transient model-API error (rate limit, 5xx) during a bounded assist must never be
    // WORSE than not having assisted recovery at all -- degrade to "didn't recover" so the
    // caller reports the original failure, rather than letting this crash the whole replay
    // run. Not retried here (unlike the discovery loop's withRetry): this is meant to be one
    // bounded attempt, not a resilient loop -- a caller who wants retries can invoke replay
    // again.
    const message = err instanceof Error ? err.message : String(err);
    logger.log({ step: stepNum, phase: "error", summary: `Assisted recovery: model call failed (${message}).` });
    return { recovered: false, note: `model call failed: ${message}` };
  }

  const call = response.candidates?.[0]?.content?.parts?.find((p) => p.functionCall !== undefined)?.functionCall;
  if (!call?.name) {
    logger.log({ step: stepNum, phase: "error", summary: "Assisted recovery: model response contained no function call." });
    return { recovered: false, note: "no function call returned" };
  }

  const input = (call.args ?? {}) as Record<string, unknown>;
  const reasoning = typeof input.reasoning === "string" ? input.reasoning : undefined;
  const { action, error } = resolveRecoveryAction(call.name, input, snapshot);

  if (!action) {
    logger.log({ step: stepNum, phase: "error", summary: `Assisted recovery: ${error}`, detail: { reasoning } });
    return { recovered: false, reasoning, note: error ?? "could not resolve proposed action" };
  }

  const authorization = await policy.authorize(surface, action);
  if (!authorization.allowed) {
    logger.log({
      step: stepNum,
      phase: "escalation",
      summary: "Assisted recovery proposed an action the guardrail policy blocks outright; refusing to execute it.",
      detail: { action, authorization, reasoning },
    });
    return { recovered: false, reasoning, note: "proposed action was blocked by guardrails" };
  }

  if (authorization.risk === "risky") {
    const proceed = onRiskyStep ? await onRiskyStep({ step }) : false;
    if (!proceed) {
      logger.log({
        step: stepNum,
        phase: "escalation",
        summary: "Assisted recovery proposed a risky action; declined (no confirmation, or confirmation refused).",
        detail: { action, authorization, reasoning },
      });
      return { recovered: false, reasoning, note: "proposed action is risky and was not confirmed" };
    }
  }

  const result = await surface.perform(action);
  logger.log({
    step: stepNum,
    phase: "act",
    summary: `Assisted recovery performed ${action.type}: ${result.ok ? "ok" : `failed (${result.error})`}`,
    detail: { action, result, reasoning, assistedRecovery: true },
  });

  return { recovered: result.ok, reasoning, note: result.ok ? "assisted action succeeded" : (result.error ?? "assisted action failed") };
}
