import { FunctionCallingConfigMode, type Content, type GoogleGenAI, type Part } from "@google/genai";
import type { Action, StateSnapshot, Surface } from "../surface/types.js";
import type { GuardrailsPolicy } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { DISCOVERY_TOOLS } from "./tool-schemas.js";
import { findElement, formatObservation } from "./observation-format.js";
import { resolveModelList, withModelFallback } from "./model-retry.js";
import type { DiscoveryResult, DiscoveryStatus, DiscoveryStep } from "./types.js";

export interface DiscoveryAgentOptions {
  surface: Surface;
  policy: GuardrailsPolicy;
  logger: EvidenceLogger;
  genai: GoogleGenAI;
  model?: string;
  maxSteps?: number;
  /** Return true to proceed with a risky action, false to decline (treated as escalation). */
  onRiskyAction?: (ctx: { step: number; action: Action; reason: string }) => Promise<boolean>;
  /** Return "resume" to continue the discovery loop after a human intervenes, "abort" to stop. */
  onEscalate?: (ctx: { step: number; reason: string; snapshot: StateSnapshot }) => Promise<"resume" | "abort">;
}

const DEFAULT_MAX_STEPS = 20;
const REPEATED_FAILURE_LIMIT = 3;

const SYSTEM_PROMPT = `You are an operator driving a legacy internal banking back-office web application on behalf of an automated goal-completion system.

You perceive the page only through a flattened list of elements (role + accessible name), not raw HTML or screenshots. You act by calling exactly one function per turn.

Rules:
- Only reference elements present in the CURRENT observation, using their exact role and name (add nth if a duplicate is indicated).
- If the goal specifies a value for a dropdown/combobox (e.g. an account type), call "select_option" for it explicitly even if the field already shows that value by default -- an unexercised default doesn't become a reusable input for future callers of this capability.
- Use "extract" to capture any data value the goal asks you to read or report.
- Call "finish" as soon as the goal's target state (e.g. a confirmation screen, or the requested data) is visible. Do not take extra actions after the goal is met.
- If you see an unexpected error banner, a permission-denied message, a validation error you cannot resolve from the goal's own instructions, or you are repeating the same failed action, call "escalate" with a clear reason instead of guessing.
- Never invent data (e.g. account numbers, dollar amounts) -- only report what "extract" actually returned.`;

function findFunctionCallPart(parts: Part[]): Part | undefined {
  return parts.find((part) => part.functionCall !== undefined);
}


function findTextPart(parts: Part[]): Part | undefined {
  return parts.find((part) => typeof part.text === "string" && !part.thought);
}

/** Deterministic JSON stringify (sorted keys) -- Gemini's function-call `args` don't come
 *  back in a stable key order between calls, so a plain `JSON.stringify` of the same
 *  logical action can produce two different strings and defeat repeated-action detection. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Signature used for dead-end detection. Excludes "reasoning": the model rephrases its
 *  justification slightly on every call, even for a logically identical retried action, so
 *  including it would make two attempts at the same action almost never compare equal. */
function actionSignature(toolName: string, input: Record<string, unknown>): string {
  const { reasoning: _reasoning, ...rest } = input;
  return `${toolName}:${stableStringify(rest)}`;
}

export class DiscoveryAgent {
  private readonly models: string[];
  private readonly maxSteps: number;

  constructor(private readonly options: DiscoveryAgentOptions) {
    this.models = options.model ? [options.model] : resolveModelList();
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async run(goal: string, startUrl: string): Promise<DiscoveryResult> {
    const { surface, policy, logger, genai } = this.options;
    const steps: DiscoveryStep[] = [];
    const outputs: Record<string, string> = {};
    const contents: Content[] = [];

    let pendingFunctionResponsePart: Part | null = null;
    let recentFailureSignature: string | null = null;
    let repeatedFailureCount = 0;
    let status: DiscoveryStatus = "max_steps";
    let finalSummary: string | undefined;
    let escalationReason: string | undefined;

    logger.log({ step: 0, phase: "start", summary: "Discovery run starting", detail: { goal, startUrl } });
    const initialNavigate = { type: "navigate", url: startUrl } as const;
    const initialNavigateResult = await surface.perform(initialNavigate);
    steps.push({
      stepIndex: 0,
      observation: { url: startUrl, title: "", elements: [], screenshotPath: "" },
      toolName: "navigate",
      toolInput: { url: startUrl },
      action: initialNavigate,
      actionResult: initialNavigateResult,
    });

    for (let stepIndex = 1; stepIndex <= this.maxSteps; stepIndex++) {
      const snapshot = await surface.observe();
      logger.log({
        step: stepIndex,
        phase: "observe",
        summary: `Observed ${snapshot.elements.length} elements at ${snapshot.url}`,
        detail: { url: snapshot.url, screenshotPath: snapshot.screenshotPath },
      });

      const observationText = formatObservation(snapshot);
      if (contents.length === 0) {
        contents.push({ role: "user", parts: [{ text: `Goal: ${goal}\n\nCurrent observation:\n${observationText}` }] });
      } else if (pendingFunctionResponsePart) {
        contents.push({
          role: "user",
          parts: [pendingFunctionResponsePart, { text: `Current observation:\n${observationText}` }],
        });
        pendingFunctionResponsePart = null;
      }

      const response = await withModelFallback(
        this.models,
        (model) =>
          genai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              tools: [{ functionDeclarations: DISCOVERY_TOOLS }],
              toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
            },
          }),
        logger
      );

      const responseParts = response.candidates?.[0]?.content?.parts ?? [];
      const functionCallPart = findFunctionCallPart(responseParts);

      if (!functionCallPart?.functionCall?.name) {
        status = "error";
        escalationReason = "Model response contained no function call.";
        break;
      }

      contents.push({ role: "model", parts: responseParts });
      const call = functionCallPart.functionCall;
      // Guarded above: functionCallPart.functionCall.name is truthy.
      const toolName: string = call.name!;
      const input = (call.args ?? {}) as Record<string, unknown>;

      // Forcing a function call every turn (mode = ANY) means Gemini never emits an
      // accompanying free-text part, so "reasoning" is requested as a structured argument
      // on the call itself instead (see tool-schemas.ts); finish/escalate already carry
      // their own "why" via summary/reason. findTextPart is a defensive fallback only.
      const rationale =
        (typeof input.reasoning === "string" ? input.reasoning : undefined) ??
        (toolName === "finish" ? (input.summary as string | undefined) : undefined) ??
        (toolName === "escalate" ? (input.reason as string | undefined) : undefined) ??
        findTextPart(responseParts)?.text;

      if (toolName === "type") {
        const target = findElement(snapshot, {
          role: input.role as string | undefined,
          name: String(input.name ?? ""),
          nth: typeof input.nth === "number" ? input.nth : 0,
        });
        if (target?.sensitive) {
          logger.addSensitiveValue(String(input.text ?? ""));
        }
      }

      logger.log({
        step: stepIndex,
        phase: "decide",
        summary: `Model chose tool "${toolName}"`,
        detail: { tool: toolName, input, rationale },
      });

      if (toolName === "finish") {
        status = "finished";
        finalSummary = String(input.summary ?? "");
        steps.push({ stepIndex, observation: snapshot, rationale, toolName, toolInput: input });
        logger.log({ step: stepIndex, phase: "outcome", summary: "Agent called finish", detail: input });
        break;
      }

      if (toolName === "escalate") {
        const reason = String(input.reason ?? "unspecified");
        logger.log({ step: stepIndex, phase: "escalation", summary: "Agent requested escalation", detail: { reason } });
        steps.push({ stepIndex, observation: snapshot, rationale, toolName, toolInput: input });

        const decision = this.options.onEscalate
          ? await this.options.onEscalate({ step: stepIndex, reason, snapshot })
          : "abort";

        if (decision === "resume") {
          pendingFunctionResponsePart = {
            functionResponse: {
              name: toolName,
              id: call.id,
              response: {
                output:
                  "A human operator took over, made manual adjustments, and handed control back. Re-observe the current state and continue toward the goal.",
              },
            },
          };
          continue;
        }
        status = "escalated";
        escalationReason = reason;
        break;
      }

      const { action, elementNotFoundError } = this.resolveAction(toolName, input, snapshot);

      if (elementNotFoundError || !action) {
        const errorMsg = elementNotFoundError ?? `Unknown tool: ${toolName}`;
        logger.log({ step: stepIndex, phase: "error", summary: errorMsg });
        steps.push({ stepIndex, observation: snapshot, rationale, toolName, toolInput: input });
        pendingFunctionResponsePart = {
          functionResponse: { name: toolName, id: call.id, response: { error: errorMsg } },
        };

        // A hallucinated element reference is the single most common failure mode and must
        // count toward the dead-end limit like any other failure -- previously this branch
        // `continue`d without ever touching repeatedFailureCount, so this case alone could
        // burn every step up to max_steps without the loop ever recognizing it was stuck.
        const notFoundSignature = actionSignature(toolName, input);
        repeatedFailureCount = notFoundSignature === recentFailureSignature ? repeatedFailureCount + 1 : 1;
        recentFailureSignature = notFoundSignature;
        if (repeatedFailureCount >= REPEATED_FAILURE_LIMIT) {
          status = "dead_end";
          escalationReason = `Repeated the same failing action ${REPEATED_FAILURE_LIMIT} times: ${notFoundSignature}`;
          logger.log({ step: stepIndex, phase: "error", summary: escalationReason });
          break;
        }
        continue;
      }

      const authorization = await policy.authorize(surface, action);
      if (!authorization.allowed) {
        logger.log({
          step: stepIndex,
          phase: "error",
          summary: `Blocked by guardrails: ${authorization.reason}`,
          detail: { authorization },
        });
        status = "escalated";
        escalationReason = `Guardrail blocked action: ${authorization.reason}`;
        steps.push({ stepIndex, observation: snapshot, rationale, toolName, toolInput: input, action });
        break;
      }

      if (authorization.risk === "risky") {
        const reason = `${authorization.method} ${authorization.route} is classified risky and requires confirmation.`;
        const proceed = this.options.onRiskyAction
          ? await this.options.onRiskyAction({ step: stepIndex, action, reason })
          : false;
        if (!proceed) {
          status = "escalated";
          escalationReason = `Risky action requires confirmation: ${authorization.method} ${authorization.route}`;
          steps.push({ stepIndex, observation: snapshot, rationale, toolName, toolInput: input, action, risk: "risky" });
          logger.log({ step: stepIndex, phase: "escalation", summary: escalationReason });
          break;
        }
      }

      const result = await surface.perform(action);
      logger.log({
        step: stepIndex,
        phase: "act",
        summary: `Performed ${action.type}: ${result.ok ? "ok" : `failed (${result.error})`}`,
        detail: { action, result },
      });

      if (toolName === "extract" && result.ok && result.extractedValue !== undefined) {
        outputs[String(input.as ?? `output_${stepIndex}`)] = result.extractedValue;
      }

      steps.push({
        stepIndex,
        observation: snapshot,
        rationale,
        toolName,
        toolInput: input,
        action,
        actionResult: result,
        risk: authorization.risk,
      });

      const signature = actionSignature(toolName, input);
      repeatedFailureCount = !result.ok && signature === recentFailureSignature ? repeatedFailureCount + 1 : result.ok ? 0 : 1;
      recentFailureSignature = result.ok ? null : signature;

      if (repeatedFailureCount >= REPEATED_FAILURE_LIMIT) {
        status = "dead_end";
        escalationReason = `Repeated the same failing action ${REPEATED_FAILURE_LIMIT} times: ${signature}`;
        logger.log({ step: stepIndex, phase: "error", summary: escalationReason });
        break;
      }

      pendingFunctionResponsePart = {
        functionResponse: {
          name: toolName,
          id: call.id,
          response: result.ok
            ? { output: `OK.${result.extractedValue !== undefined ? ` Extracted: ${result.extractedValue}` : ""}` }
            : { error: result.error },
        },
      };
    }

    logger.log({
      step: steps.length,
      phase: "end",
      summary: `Discovery run ended with status "${status}"`,
      detail: { status, outputs, finalSummary, escalationReason },
    });

    return { status, goal, startUrl, steps, outputs, finalSummary, escalationReason };
  }

  private resolveAction(
    toolName: string,
    input: Record<string, unknown>,
    snapshot: StateSnapshot
  ): { action?: Action; elementNotFoundError?: string } {
    if (toolName === "navigate") {
      return { action: { type: "navigate", url: String(input.url) } };
    }

    const role = input.role as string | undefined;
    const name = String(input.name ?? "");
    const nth = typeof input.nth === "number" ? input.nth : 0;
    const element = findElement(snapshot, { role, name, nth });

    if (!element) {
      return { elementNotFoundError: `No element found matching role=${role ?? "any"} name="${name}" nth=${nth}` };
    }

    if (toolName === "click") {
      return { action: { type: "click", target: element.locatorCandidates } };
    }
    if (toolName === "type") {
      return { action: { type: "type", target: element.locatorCandidates, text: String(input.text ?? "") } };
    }
    if (toolName === "select_option") {
      return { action: { type: "select_option", target: element.locatorCandidates, option: String(input.option ?? "") } };
    }
    if (toolName === "extract") {
      return { action: { type: "extract", target: element.locatorCandidates } };
    }

    return { elementNotFoundError: `Unknown tool: ${toolName}` };
  }
}
