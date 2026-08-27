import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Domain knowledge about THIS target app's error surface and milestones. Not mined from
 * a single happy-path discovery trace -- authored the same way a human reviewer would
 * annotate a capability before approving it for unattended replay. See REPORT.md "Cuts".
 */

export const OPEN_SUB_ACCOUNT_PARAM_MAPPINGS: ParamMapping[] = [
  {
    role: "textbox",
    name: "Operator ID",
    paramName: "username",
    type: "string",
    description: "Operator ID used to sign on to the terminal.",
  },
  {
    role: "textbox",
    name: "Password",
    paramName: "password",
    type: "string",
    sensitive: true,
    description: "Operator password used to sign on to the terminal.",
  },
  {
    role: "textbox",
    name: "Member ID",
    paramName: "memberId",
    type: "string",
    description: "The member to open a sub-account for.",
  },
  {
    role: "combobox",
    name: "Account Type",
    paramName: "accountType",
    type: "string",
    description: "Savings, Checking, or CD.",
  },
  {
    role: "textbox",
    name: "Initial Deposit ($)",
    paramName: "initialDeposit",
    type: "string",
    description: "Opening deposit amount in dollars.",
  },
];

export const OPEN_SUB_ACCOUNT_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "Sub-account opened successfully",
  description: "The confirmation banner is visible.",
};

export const OPEN_SUB_ACCOUNT_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "member_not_found",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "No member found with ID", description: "Search returned no matching member." },
    description: "No member exists with the given memberId. A legitimate result, not a crash.",
  },
  {
    name: "permission_denied",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "Access denied", description: "Operator lacks permission to view this member." },
    description: "The signed-on operator is not permitted to view this member's accounts.",
  },
  {
    name: "validation_error",
    category: "business_outcome",
    detector: {
      kind: "text_match",
      expr: "Initial deposit must be at least",
      description: "Sub-account form rejected the initial deposit.",
    },
    description: "The initial deposit amount did not meet the minimum required ($25).",
  },
  {
    name: "session_timeout",
    category: "recoverable",
    detector: { kind: "text_match", expr: "session has expired", description: "Session expired mid-flow, redirected to sign-on." },
    description: "The operator session expired mid-flow; automation re-authenticates and retries the step once.",
    recovery: "reauthenticate_and_retry_step",
    // step-2/3/4 are the sign-on sequence (type username, type password, click Sign On).
    // step-5 (re-type memberId) is also needed: the redirect to /login lands on a fresh
    // /search page, so the in-page search field state from before the timeout is gone.
    recoveryStepIds: ["step-2", "step-3", "step-4", "step-5"],
  },
];

/** Attaches milestone checkpoints by matching on step content, not a guessed step index --
 *  robust to the discovery agent taking a slightly different number/order of steps. */
export function annotateOpenSubAccountCheckpoints(artifact: CapabilityArtifact): void {
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Sign On"), {
    kind: "url",
    expr: "/search",
    description: "Reached the search page after signing on.",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Look Up Member"), {
    kind: "url",
    expr: "/members/{memberId}",
    description: "Reached the member detail page.",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Open New Sub-Account"), {
    kind: "url",
    expr: "/members/{memberId}/sub-accounts/new",
    description: "Reached the new sub-account form.",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Submit"), {
    kind: "url",
    expr: "/members/{memberId}/sub-accounts/*/confirm",
    description: "Reached the sub-account confirmation page.",
  });
}
