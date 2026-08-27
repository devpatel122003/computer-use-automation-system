import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Domain knowledge for the third real capability: a read-only lookup, not a write. Every
 * step this needs already exists on `/members/:id` (checkingBalanceValue/savingsBalanceValue
 * spans) -- no new mock-bank route required, unlike open-sub-account and create-member.
 * Authored the same way those two are: a human reviewer's annotation on top of a real
 * discovery trace, not mined from it. See REPORT.md "Cuts".
 */

export const CHECK_BALANCE_PARAM_MAPPINGS: ParamMapping[] = [
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
    description: "The member whose balances to look up.",
  },
];

export const CHECK_BALANCE_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "url",
  expr: "/members/{memberId}",
  description: "Reached the member detail page showing both balances.",
};

export const CHECK_BALANCE_KNOWN_OUTCOMES: KnownOutcome[] = [
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
    description: "The signed-on operator is not permitted to view this member's balances.",
  },
  {
    name: "session_timeout",
    category: "recoverable",
    detector: { kind: "text_match", expr: "session has expired", description: "Session expired mid-flow, redirected to sign-on." },
    description: "The operator session expired mid-flow; automation re-authenticates and retries the step once.",
    recovery: "reauthenticate_and_retry_step",
    recoveryStepIds: ["step-2", "step-3", "step-4", "step-5"],
  },
];

/** Attaches the one real milestone this flow has -- reaching the member page itself. There's
 *  no "submit" step to distinguish here (this never writes anything), so unlike
 *  open-sub-account/create-member, only the sign-on and lookup milestones need annotating. */
export function annotateCheckBalanceCheckpoints(artifact: CapabilityArtifact): void {
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Sign On"), {
    kind: "url",
    expr: "/search",
    description: "Reached the search page after signing on.",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Look Up Member"), CHECK_BALANCE_SUCCESS_CHECKPOINT);
}
