import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { replay } from "../replay/replay-engine.js";

const USERNAME = "demo_operator";
const PASSWORD = "demo_password";
// apps/mock-bank's requiresInterstitialConfirmation scenario (see data.ts): opening a
// sub-account for this member renders an unexpected interstitial the recorded artifact
// never accounted for, instead of going straight to confirmation.
const INTERSTITIAL_MEMBER_ID = "77777";

/**
 * The replay-side counterpart to escalation-resume-demo.ts: demonstrates a REPLAY (not
 * discovery) hard failure being escalated to a human, resumed on the same live session, and
 * the run actually completing afterward -- the one gap REPORT.md's Cuts previously named as
 * "no mid-artifact resume after a replay hard failure."
 *
 * Member 77777 triggers an unexpected confirmation interstitial (the brief's own named
 * runtime condition, Section 1) that the recorded artifact's step-10 checkpoint (expects to
 * land on the sub-account confirmation page) was never written to expect, and that isn't
 * modeled in this artifact's knownOutcomes -- so replay genuinely hard-fails there, with
 * nothing to explain the deviation automatically. A human looking at the live page would
 * immediately recognize what to do: click "Confirm & Continue." This process has no mouse to
 * hand to an actual human, so that one click is scripted -- disclosed here, the same way
 * escalation-resume-demo.ts discloses its own scripted navigation. Like that script, this one
 * deliberately does its own intervention bookkeeping (screenshot, evidence record, console
 * output) instead of going through EscalationController: that class's requestIntervention()/
 * confirmRiskyAction() block on a real terminal prompt, which would hang a scripted,
 * unattended demo with no one to type an answer -- the same failure mode
 * src/escalation/prompt.ts was fixed for, avoided here by not needing a prompt at all. What's
 * real, not scripted: the pause, the resume decision routed back into replay(), the
 * post-resume checkpoint recheck, and the run actually completing afterward on the same
 * session.
 */
async function main(): Promise<void> {
  const artifactPath = "evidence/artifacts/open-sub-account.artifact.json";
  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const artifact = CapabilityArtifactSchema.parse(raw);

  const params = {
    username: USERNAME,
    password: PASSWORD,
    memberId: INTERSTITIAL_MEMBER_ID,
    accountType: "Savings",
    initialDeposit: "100",
  };

  const runId = newRunId("replay");
  const logger = new EvidenceLogger({ runId, runType: "replay" });
  logger.addSensitiveValue(PASSWORD);
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed: true });

  try {
    await surface.launch("about:blank");
    const policy = new GuardrailsPolicy();
    let interventionCount = 0;

    console.log(`Replay run: ${runId}`);
    console.log(`Artifact: ${artifact.name} v${artifact.version}`);
    console.log(`Params: ${JSON.stringify({ ...params, password: "[REDACTED]" })}\n`);
    console.log("Opening a sub-account for member 77777 (flagged dormant) will hit an unexpected");
    console.log("confirmation interstitial that this artifact's recorded steps never accounted for.\n");

    const result = await replay({
      artifact,
      params,
      surface,
      policy,
      logger,
      runId,
      allowRisky: true,
      onRiskyStep: async ({ step }) => {
        logger.log({ step: 0, phase: "escalation", summary: `Risky action auto-approved for this demo: ${step.id} -- ${step.description}` });
        return true;
      },
      onEscalate: async ({ step, stepNum, reason }) => {
        interventionCount += 1;
        const screenshotPath = path.join(logger.screenshotsDir, `intervention-${interventionCount}.png`);
        await surface
          .getPage()
          .screenshot({ path: screenshotPath })
          .catch((err) => logger.log({ step: stepNum, phase: "error", summary: `Could not capture intervention screenshot: ${err}` }));

        logger.writeJson(`intervention-${interventionCount}.json`, {
          runId,
          runType: "replay",
          capability: artifact.name,
          step: step.id,
          reason,
          screenshotPath,
          url: surface.currentUrl(),
          createdAt: new Date().toISOString(),
        });
        logger.log({ step: stepNum, phase: "escalation", summary: `Intervention requested: ${reason}` });

        console.log(`\n=== HUMAN INTERVENTION (scripted operator action for this demo) ===`);
        console.log(`Step: ${step.id} -- ${reason}`);
        console.log(
          "Operator: this member requires an extra confirmation click before the sub-account " +
            "opens -- not something automation can resolve on its own. Clicking through it on the " +
            "SAME live session, then handing control back."
        );

        // The scripted stand-in for a human's manual click -- see the header comment above
        // and escalation-resume-demo.ts's identical disclosure for the discovery-side case.
        // Deliberately calls surface.perform() directly rather than going through
        // executeStep/authorizeAndConfirm: a human operator's own action during their turn in
        // control isn't something the automation guardrail layer authorizes, the same way
        // escalation-resume-demo.ts's scripted navigation isn't either.
        await surface.perform({
          type: "click",
          target: [{ strategy: "role", role: "button", name: "Confirm & Continue", nth: 0, confidence: "high", rationale: "scripted operator action" }],
        });

        logger.log({
          step: stepNum,
          phase: "escalation",
          summary: "Operator resolved intervention with: resume",
          detail: { decision: "resume" },
        });
        return "resume";
      },
    });

    logger.writeJson("replay-result.json", result);

    console.log(`\nReplay finished with status: ${result.status}`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`Interventions raised: ${interventionCount}`);
    console.log(`Evidence written to: ${logger.runDir}`);

    process.exitCode = result.status === "failure" ? 1 : 0;
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
