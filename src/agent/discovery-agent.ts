import { FunctionCallingConfigMode, type Content, type GoogleGenAI, type Part } from "@google/genai";
import type { Action, StateSnapshot, Surface } from "../surface/types.js";
import type { GuardrailsPolicy } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { DISCOVERY_TOOLS } from "./tool-schemas.js";
import { findElement, formatObservation } from "./observation-format.js";
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

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";
const DEFAULT_MAX_STEPS = 20;
const REPEATED_FAILURE_LIMIT = 3;

const SYSTEM_PROMPT = `You are an operator driving a legacy internal banking back-office web application on behalf of an automated goal-completion system.

You perceive the page only through a flattened list of elements (role + accessible name), not raw HTML or screenshots. You act by calling exactly one function per turn.

Rules:
- Only reference elements present in the CURRENT observation, using their exact role and name (add nth if a duplicate is indicated).
- Use "extract" to capture any data value the goal asks you to read or report.
- Call "finish" as soon as the goal's target state (e.g. a confirmation screen, or the requested data) is visible. Do not take extra actions after the goal is met.
- If you see an unexpected error banner, a permission-denied message, a validation error you cannot resolve from the goal's own instructions, or you are repeating the same failed action, call "escalate" with a clear reason instead of guessing.
- Never invent data (e.g. account numbers, dollar amounts) -- only report what "extract" actually returned.`;

function findFunctionCallPart(parts: Part[]): Part | undefined {
  return parts.find((part) => part.functionCall !== undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Free-tier Gemini quotas are tight (e.g. 5 req/min); back off on 429s using the
 *  server-suggested retryDelay rather than failing the whole discovery run. */
async function withRetry<T>(fn: () => Promise<T>, logger: EvidenceLogger, maxAttempts = 6): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = (err as { status?: number })?.status === 429 || message.includes("RESOURCE_EXHAUSTED");
      if (!isRateLimit || attempt === maxAttempts) throw err;

      const match = message.match(/"retryDelay":"(\d+)s"/);
      const delayMs = (match ? Number(match[1]) : 15) * 1000 + 1000;
      logger.log({
        step: 0,
        phase: "error",
        summary: `Gemini rate-limited (attempt ${attempt}/${maxAttempts}); waiting ${delayMs}ms before retry.`,
      });
      await sleep(delayMs);
    }
  }
  throw new Error("unreachable");
}

function findTextPart(parts: Part[]): Part | undefined {
  return parts.find((part) => typeof part.text === "string" && !part.thought);
}

export class DiscoveryAgent {
  private readonly model: string;
  private readonly maxSteps: number;

  constructor(private readonly options: DiscoveryAgentOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
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

      const response = await withRetry(
        () =>
          genai.models.generateContent({
            model: this.model,
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

      const signature = `${toolName}:${JSON.stringify(input)}`;
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
