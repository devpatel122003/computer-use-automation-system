import path from "node:path";
import type { Page, Frame } from "playwright";
import type { EvidenceLogger } from "../evidence/logger.js";
import { promptLine } from "./prompt.js";
import type { CapturedHumanAction, InterventionDecision, InterventionRequest } from "./types.js";

/**
 * Real (not mocked) handoff mechanism: the browser is launched headed, so "ceding
 * control" means automation simply stops issuing commands on this exact Page/session
 * while a human operates the same visible window. A `controller` flag records who is
 * in charge; frame navigations during the human's turn are captured as evidence.
 * The operator surface itself (a CLI prompt) is intentionally minimal -- see REPORT.md
 * "Escalation & handoff" for the scoped-out real co-browsing console this stands in for.
 */
export class EscalationController {
  private controller: "automation" | "human" = "automation";
  private capturedActions: CapturedHumanAction[] = [];
  private navigationListener?: (frame: Frame) => void;
  private counter = 0;

  constructor(
    private readonly page: Page,
    private readonly logger: EvidenceLogger,
    private readonly runId: string,
    private readonly runType: "discovery" | "replay",
    private readonly capability: string
  ) {}

  whoIsInControl(): "automation" | "human" {
    return this.controller;
  }

  async requestIntervention(params: { step: number | string; reason: string }): Promise<InterventionDecision> {
    if (this.controller === "human") {
      // Defensive: in this single-process design the caller always awaits the previous
      // requestIntervention() to resolve before issuing another, so this shouldn't be
      // reachable -- but if some future caller ever raced two escalations, silently
      // overwriting the in-progress one would lose evidence, not just log noise.
      this.logger.log({
        step: 0,
        phase: "error",
        summary: "requestIntervention called while a human already has control; ignoring the re-entrant call.",
      });
      return "abort";
    }

    this.counter += 1;
    const id = `${this.runId}-intervention-${this.counter}`;
    const screenshotPath = path.join(this.logger.screenshotsDir, `intervention-${this.counter}.png`);
    await this.page.screenshot({ path: screenshotPath }).catch((err) => {
      this.logger.log({ step: 0, phase: "error", summary: `Could not capture intervention screenshot: ${err}` });
    });

    const request: InterventionRequest = {
      id,
      runId: this.runId,
      runType: this.runType,
      capability: this.capability,
      step: params.step,
      reason: params.reason,
      screenshotPath,
      url: this.page.url(),
      createdAt: new Date().toISOString(),
    };

    this.logger.writeJson(`intervention-${this.counter}.json`, request);
    this.logger.log({
      step: typeof params.step === "number" ? params.step : 0,
      phase: "escalation",
      summary: `Intervention requested: ${params.reason}`,
      detail: { request },
    });

    this.controller = "human";
    this.capturedActions = [];
    this.navigationListener = (frame) => {
      if (frame === this.page.mainFrame()) {
        this.capturedActions.push({ type: "navigation", detail: frame.url(), ts: new Date().toISOString() });
      }
    };
    this.page.on("framenavigated", this.navigationListener);

    console.log("\n=== HUMAN INTERVENTION REQUESTED ===");
    console.log(`Capability: ${this.capability}`);
    console.log(`Reason: ${params.reason}`);
    console.log(`Current URL: ${request.url}`);
    console.log(`Screenshot: ${screenshotPath}`);
    console.log("The browser window is live -- take manual action in it now.");
    console.log("Press [Enter] to hand control back to automation, or type 'abort' + Enter to stop the run.\n");

    const answer = await promptLine("> ");

    if (this.navigationListener) {
      this.page.off("framenavigated", this.navigationListener);
      this.navigationListener = undefined;
    }
    this.controller = "automation";

    const decision: InterventionDecision = answer.trim().toLowerCase() === "abort" ? "abort" : "resume";
    this.logger.log({
      step: typeof params.step === "number" ? params.step : 0,
      phase: "escalation",
      summary: `Operator resolved intervention with: ${decision}`,
      detail: { decision, capturedActions: this.capturedActions },
    });
    return decision;
  }

  async confirmRiskyAction(reason: string): Promise<boolean> {
    console.log("\n=== RISKY ACTION REQUIRES CONFIRMATION ===");
    console.log(reason);
    const answer = await promptLine("Type 'yes' to proceed, anything else to decline: ");
    const approved = answer.trim().toLowerCase() === "yes";
    this.logger.log({ step: 0, phase: "escalation", summary: `Risky action ${approved ? "approved" : "declined"} by operator`, detail: { reason, approved } });
    return approved;
  }
}
