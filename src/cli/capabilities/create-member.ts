import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickMatching, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Domain knowledge for the second real capability this system records: enrolling a brand
 * new member, rather than acting on an existing one. Authored the same way
 * open-sub-account.ts is -- a human reviewer's annotation on top of a real discovery
 * trace, not mined from a single happy-path run. See REPORT.md "Cuts".
 */

export const CREATE_MEMBER_PARAM_MAPPINGS: ParamMapping[] = [
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
    name: "Full Name",
    paramName: "fullName",
    type: "string",
    description: "Full name of the new member to enroll.",
  },
  {
    role: "textbox",
    name: "Initial Checking Deposit ($)",
    paramName: "initialChecking",
    type: "string",
    required: false,
    description: "Opening checking account balance in dollars. Defaults to $0 if omitted -- the target app itself treats a blank deposit field as zero, not an error.",
  },
  {
    role: "textbox",
    name: "Initial Savings Deposit ($)",
    paramName: "initialSavings",
    type: "string",
    required: false,
    description: "Opening savings account balance in dollars. Defaults to $0 if omitted -- the target app itself treats a blank deposit field as zero, not an error.",
  },
];

export const CREATE_MEMBER_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "New member created successfully",
  description: "The new-member confirmation banner is visible.",
};

export const CREATE_MEMBER_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "validation_error",
    category: "business_outcome",
    detector: {
      kind: "text_match",
      expr: "Full name is required",
      description: "New-member form rejected the submission.",
    },
    description: "The submitted name was blank, or an initial deposit amount wasn't a valid non-negative number.",
  },
];

/** Attaches milestone checkpoints by matching on step content, not a guessed step index --
 *  robust to the discovery agent taking a slightly different number/order of steps. The
 *  nav link and the submit button deliberately carry different visible text
 *  ("Create New Member" vs. "Create Member") specifically so this matching can tell them
 *  apart; sharing one label would have made this annotation ambiguous. */
export function annotateCreateMemberCheckpoints(artifact: CapabilityArtifact): void {

  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Sign On"), {
    kind: "url",
    expr: "/search",
    description: "Reached the search page after signing on.",
  });
  attachStepCheckpoint(artifact, (s) => isClickMatching(s, "Create New Member") || isClickMatching(s, "Enroll New Member"), {
    kind: "url",
    expr: "/members/new",
    description: "Reached the new-member enrollment form.",
  });
  attachStepCheckpoint(artifact, (s) => isClickMatching(s, "Create Member") || isClickMatching(s, "Enroll Member"), {
    kind: "url",
    expr: "/members/new/confirm/*",
    description: "Reached the new-member confirmation page.",
  });
}
