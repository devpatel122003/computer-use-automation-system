import "dotenv/config";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { DiscoveryAgent } from "../agent/discovery-agent.js";

const USERNAME = "demo_operator";
const PASSWORD = "demo_password";
const START_URL = "http://localhost:4000/login";

/**
 * Demonstrates the one escalation path the rest of /evidence never actually exercises:
 * a human resolving an intervention with RESUME (not abort) and the discovery loop
 * completing the goal afterward on the same live session.
 *
 * Member 99999 is permission-denied -- not something automation can route around on its
 * own, and not something a human can fix server-side either. What a human operator *can*
 * do is redirect the same browser session to a member they're actually permitted to serve,
 * which is exactly what happens below. This process has no mouse/keyboard to hand to an
 * actual human, so the operator's action is scripted: `surface.perform()` navigates the
 * exact same Page the discovery loop was just driving, standing in for someone manually
 * typing a new URL into that visible window. Everything else -- the pause, the screenshot
 * and intervention record, the resume decision routed back into DiscoveryAgent, Gemini
 * re-observing and continuing, and the goal actually completing -- is real.
 */
async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Export it or add it to a .env file (see README.md).");
    process.exit(1);
  }

  const runId = newRunId("discovery");
  const logger = new EvidenceLogger({ runId, runType: "discovery" });
  logger.addSensitiveValue(PASSWORD);
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed: true });

  try {
    await surface.launch(START_URL);
    const policy = new GuardrailsPolicy();
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    let interventionCount = 0;

    const agent = new DiscoveryAgent({
      surface,
      policy,
      logger,
      genai,
      onRiskyAction: async ({ reason }) => {
        logger.log({ step: 0, phase: "escalation", summary: `Risky action auto-approved for this demo: ${reason}` });
        return true;
      },
      onEscalate: async ({ step, reason }) => {
        interventionCount += 1;
        const screenshotPath = path.join(logger.screenshotsDir, `intervention-${interventionCount}.png`);
        await surface
          .getPage()
          .screenshot({ path: screenshotPath })
          .catch((err) => logger.log({ step, phase: "error", summary: `Could not capture intervention screenshot: ${err}` }));

        logger.writeJson(`intervention-${interventionCount}.json`, {
          runId,
          capability: "open-sub-account",
          step,
          reason,
          screenshotPath,
          url: surface.currentUrl(),
          createdAt: new Date().toISOString(),
        });
        logger.log({ step, phase: "escalation", summary: `Intervention requested: ${reason}` });

        console.log("\n=== HUMAN INTERVENTION (scripted operator action for this demo) ===");
        console.log(`Reason: ${reason}`);
        console.log("Operator: member 99999 is permission-denied and not fixable from this session; " +
          "redirecting to a permitted member (10001) on the SAME browser session and resuming automation.");

        await surface.perform({ type: "navigate", url: "http://localhost:4000/members/10001" });

        logger.log({
          step,
          phase: "escalation",
          summary: "Operator resolved intervention with: resume",
          detail: {
            decision: "resume",
            capturedActions: [{ type: "navigation", detail: "http://localhost:4000/members/10001", ts: new Date().toISOString() }],
          },
        });
        return "resume";
      },
    });

    const goal =
      `Sign on as operator "${USERNAME}" with password "${PASSWORD}", look up member 99999, and open a new ` +
      "Savings sub-account for them with an initial deposit of $100. If member 99999 cannot be accessed, " +
      "escalate to a human operator; once they hand control back, continue the same task using whichever " +
      "member the browser is currently showing instead of retrying 99999.";

    console.log(`Discovery run: ${runId}`);
    console.log(`Goal: ${goal}\n`);

    const result = await agent.run(goal, START_URL);
    logger.writeJson("discovery-result.json", result);

    console.log(`\nDiscovery finished with status: ${result.status}`);
    if (result.finalSummary) console.log(`Summary: ${result.finalSummary}`);
    if (result.escalationReason) console.log(`Escalation reason: ${result.escalationReason}`);
    if (Object.keys(result.outputs).length > 0) console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
    console.log(`Evidence written to: ${logger.runDir}`);
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
