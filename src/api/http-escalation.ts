import path from "node:path";
import type { Page } from "playwright";
import type { ArtifactStep } from "../artifact/schema.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import type { InterventionDecision, InterventionRequest } from "../escalation/types.js";

/**
 * The capability API's own escalation mechanism -- distinct from EscalationController
 * (src/escalation/controller.ts), which blocks on a real terminal prompt for a human sitting
 * at the CLI. An HTTP request has no terminal to prompt: the human here is watching the
 * console (chat-ui) or dashboard in a browser tab, not this process's stdin. Pausing still
 * means the exact same real thing though -- automation stops issuing commands on this real,
 * headed Playwright page (visible on the same machine the demo runs on, since capability-api
 * launches it headed by default) while a human looks at it and, separately, resolves the
 * pause through a small HTTP surface this module backs: `GET /interventions` (what's
 * pending, plus a screenshot) and `POST /interventions/:id/resolve` (resume or abort). The
 * original `POST /capabilities/:id/invoke` request that triggered the escalation stays open,
 * blocked on the exact same in-memory Promise `resolve()` settles -- there is no separate
 * "reconnect to a paused run later" leg, and nothing here survives a process restart (an
 * in-memory Map, not a queue) -- consistent with this project's "don't build scaling
 * infrastructure you don't need" posture (brief §9) for what is fundamentally a demo escape
 * hatch, not a production incident-management system.
 */

export interface PendingIntervention extends InterventionRequest {}

interface PendingEntry {
  request: PendingIntervention;
  resolve: (decision: InterventionDecision) => void;
  timer: NodeJS.Timeout;
}

// Generous for a live demo (a presenter fumbling with a real browser window takes longer
// than a script would), but finite: an intervention nobody ever answers would otherwise tie
// up a real headed browser instance and one of this process's rate-limited /invoke slots
// forever. Timing out to "abort" is the same conservative default resolveInterventionDecision
// already applies to a closed/absent terminal answer -- no answer is never treated as "yes."
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class HttpEscalationRegistry {
  private pending = new Map<string, PendingEntry>();
  private counter = 0;

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  list(): PendingIntervention[] {
    return [...this.pending.values()].map((e) => e.request);
  }

  getScreenshotPath(id: string): string | undefined {
    return this.pending.get(id)?.request.screenshotPath;
  }

  /** Resolves a pending intervention by id. Returns false for an unknown id (already
   *  resolved, timed out, or just a bad id from a stale browser tab) -- the /resolve route
   *  turns that into a 404, not a silent no-op a caller could mistake for success. */
  resolve(id: string, decision: InterventionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }

  /** Builds an onEscalate callback for one specific replay run, bound to its own page/logger/
   *  runId/capability so every intervention it raises carries the right context -- the exact
   *  same fields EscalationController's own requestIntervention() writes, so evidence/runs/
   *  looks identical regardless of which caller (CLI or HTTP) raised the escalation. */
  createOnEscalate(params: { page: Page; logger: EvidenceLogger; runId: string; capability: string }) {
    return async (ctx: { step: ArtifactStep; stepNum: number; reason: string }): Promise<InterventionDecision> => {
      this.counter += 1;
      const id = `${params.runId}-intervention-${this.counter}`;
      const screenshotPath = path.join(params.logger.screenshotsDir, `intervention-${this.counter}.png`);
      await params.page.screenshot({ path: screenshotPath }).catch((err) => {
        params.logger.log({ step: 0, phase: "error", summary: `Could not capture intervention screenshot: ${err}` });
      });

      const request: PendingIntervention = {
        id,
        runId: params.runId,
        runType: "replay",
        capability: params.capability,
        step: ctx.step.id,
        reason: ctx.reason,
        screenshotPath,
        url: params.page.url(),
        createdAt: new Date().toISOString(),
      };

      params.logger.writeJson(`intervention-${this.counter}.json`, request);
      params.logger.log({
        step: ctx.stepNum,
        phase: "escalation",
        summary: `Intervention requested (HTTP): ${ctx.reason}`,
        detail: { request },
      });

      return new Promise<InterventionDecision>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          params.logger.log({ step: 0, phase: "escalation", summary: `Intervention ${id} timed out with no human response; aborting.` });
          resolve("abort");
        }, this.timeoutMs);
        this.pending.set(id, { request, resolve, timer });
      });
    };
  }
}
