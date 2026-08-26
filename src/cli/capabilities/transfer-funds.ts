import type { ArtifactStep, CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Domain knowledge for the fourth real capability: moving funds between a member's OWN
 * checking and savings balances -- a write, unlike check-balance, but scoped to money that
 * already belongs to the member, distinct in kind from open-sub-account's "create a new
 * account" write. Authored the same way every other capability's domain config is: a human
 * reviewer's annotation on top of a real discovery trace. See REPORT.md "Cuts".
 */

export const TRANSFER_FUNDS_PARAM_MAPPINGS: ParamMapping[] = [
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
    description: "The member whose own checking/savings funds to move.",
  },
  {
    role: "combobox",
    name: "From Account",
    paramName: "fromAccount",
    type: "string",
    description: "Which of the member's own accounts to move funds out of: Checking or Savings.",
  },
  {
    role: "combobox",
    name: "To Account",
    paramName: "toAccount",
    type: "string",
    description: "Which of the member's own accounts to move funds into: Checking or Savings.",
  },
  {
    role: "textbox",
    name: "Amount ($)",
    paramName: "amount",
    type: "string",
    description: "Dollar amount to transfer. Plain numeric value, no currency symbol.",
  },
];

export const TRANSFER_FUNDS_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "Funds transferred successfully",
  description: "The transfer confirmation banner is visible.",
};

export const TRANSFER_FUNDS_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "member_not_found",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "No member found with ID", description: "Search returned no matching member." },
    description: "No member exists with the given memberId. A legitimate result, not a crash.",
  },
  {
    name: "insufficient_funds",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "Insufficient funds", description: "The source account doesn't have enough available balance." },
    description: "The source account's balance is lower than the requested transfer amount -- a legitimate business outcome, not a system error.",
  },
  {
    name: "invalid_transfer",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "must be a valid, positive number", description: "The transfer form rejected the request itself (bad amount or same account on both sides)." },
    description: "The requested transfer amount wasn't a valid positive number, or the source and destination accounts were the same.",
  },
];

/** Attaches milestone checkpoints by matching on step content. The transfer form's own
 *  link and submit button carry different text ("Transfer Funds" vs. "Submit Transfer"),
 *  same reasoning as create-member's link/submit split -- sharing one label would make this
 *  matching ambiguous. */
export function annotateTransferFundsCheckpoints(artifact: CapabilityArtifact): void {
  const isClickNamed = (step: ArtifactStep, name: string) => step.actionType === "click" && step.description.includes(`"${name}"`);
  const isClickMatching = (step: ArtifactStep, name: string) => step.actionType === "click" && step.description.toLowerCase().includes(name.toLowerCase());

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
  attachStepCheckpoint(artifact, (s) => isClickMatching(s, "Transfer Funds") || isClickMatching(s, "Move Money"), {
    kind: "url",
    expr: "/members/{memberId}/transfer",
    description: "Reached the transfer-funds form.",
  });
  attachStepCheckpoint(artifact, (s) => isClickMatching(s, "Submit Transfer") || isClickMatching(s, "Confirm Transfer"), {
    kind: "url",
    expr: "/members/{memberId}/transfer/confirm",
    description: "Reached the transfer confirmation page.",
  });
}
