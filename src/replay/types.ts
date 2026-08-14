export interface ReplaySuccessResult {
  status: "success";
  runId: string;
  outputs: Record<string, string>;
}

export interface ReplayBusinessOutcomeResult {
  status: "business_outcome";
  runId: string;
  outcome: string;
  description: string;
  stepId?: string;
  evidenceRef?: string;
}

export interface ReplayFailureResult {
  status: "failure";
  runId: string;
  stepId: string;
  expected: string;
  observed: string;
  evidenceRef: string;
}

export type ReplayResult = ReplaySuccessResult | ReplayBusinessOutcomeResult | ReplayFailureResult;
