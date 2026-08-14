export interface InterventionRequest {
  id: string;
  runId: string;
  runType: "discovery" | "replay";
  /** Which capability/goal this run is for. */
  capability: string;
  step: number | string;
  reason: string;
  screenshotPath: string;
  url: string;
  createdAt: string;
}

export type InterventionDecision = "resume" | "abort";

export interface CapturedHumanAction {
  type: "navigation";
  detail: string;
  ts: string;
}
