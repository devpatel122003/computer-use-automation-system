import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { attemptAssistedRecovery } from "../replay/assisted-recovery.js";
import type { ArtifactStep } from "../artifact/schema.js";
import { parseArgs } from "./args.js";

/**
 * Real, isolated evidence for the vision-grounded fallback (src/replay/assisted-recovery.ts's
 * click_at_coordinates tool) against apps/mock-bank's canvas-only negative-control fixture
 * (views/legacyWidgetDemo.ejs) -- not part of the open-sub-account artifact, so this is a
 * dedicated script rather than shoehorning a fake step into an unrelated capability.
 *
 * Simulates exactly what replay's executeStep does on a mechanical failure: the "recorded"
 * step targets a button by role+name, which -- correctly -- resolves to nothing at all,
 * since the button is drawn on a <canvas> with no DOM semantics. attemptAssistedRecovery is
 * then invoked directly, real Gemini call included, and asked to look at the actual
 * screenshot instead.
 */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? "http://localhost:4000";
  const headed = args.headless !== "true";

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Export it or add it to a .env file (see README.md).");
    process.exitCode = 1;
    return;
  }

  const runId = newRunId("discovery"); // reuses the discovery-run evidence shape; this isn't a replay of any saved artifact
  const logger = new EvidenceLogger({ runId, runType: "discovery" });
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });

  try {
    await surface.launch(`${baseUrl}/legacy-widget-demo`);
    const policy = new GuardrailsPolicy();

    // The "recorded" step, deliberately targeting the canvas button the only way a DOM-
    // based recorder ever could -- by role+name -- which will not resolve, since there is
    // no such DOM element. This is the genuine mechanical failure a real artifact recorded
    // against a DOM-based UI would hit if that UI were later replaced by a canvas widget.
    const step: ArtifactStep = {
      id: "step-1",
      actionType: "click",
      description: 'Click the "Check Balance" button',
      locator: [{ strategy: "role", role: "button", name: "Check Balance", nth: 0, confidence: "high", rationale: "recorded against a DOM button that no longer exists" }],
      risk: "safe",
      waitPolicy: { timeoutMs: 3000, retries: 0 },
    };

    const resolved = await surface.perform({ type: "click", target: step.locator! });
    console.log(`Recorded (DOM-based) action result: ${resolved.ok ? "ok" : `failed (${resolved.error})`}`);
    console.log(`URL immediately after the failed recorded click: ${surface.currentUrl()}`);
    if (resolved.ok) {
      console.log("The recorded action unexpectedly succeeded -- the fixture isn't exercising the failure this demo needs.");
      return;
    }

    console.log("\nInvoking attemptAssistedRecovery for real (one bounded Gemini call, vision fallback offered)...");
    const outcome = await attemptAssistedRecovery({
      config: { genai: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) },
      surface,
      policy,
      logger,
      step,
      stepNum: 1,
      failureContext: resolved.error ?? "element not found",
      onRiskyStep: async ({ step: s }) => {
        console.log(`\n=== ASSISTED RECOVERY PROPOSED A RISKY ACTION FOR: ${s.description} ===`);
        return true; // auto-approve for this demo; a real CLI would prompt, same as escalation/controller.ts
      },
    });

    console.log(`\nOutcome: recovered=${outcome.recovered}, note="${outcome.note}"`);
    if (outcome.reasoning) console.log(`Model's reasoning: ${outcome.reasoning}`);
    console.log(`Final URL: ${surface.currentUrl()}`);
    console.log(`Landed on confirmation page: ${surface.currentUrl().includes("/legacy-widget-demo/confirmed")}`);
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
