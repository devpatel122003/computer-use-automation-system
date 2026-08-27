import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Domain knowledge for the fifth real capability: closing an existing sub-account. Takes
 * `subId` as an input rather than trying to find "the" sub-account by type -- a member can
 * have more than one, and the artifact's own contract should be unambiguous about which one
 * it acts on, the same reasoning open-sub-account's memberId is a real input, not something
 * discovered fresh each run. Authored the same way every other capability's domain config
 * is: a human reviewer's annotation on top of a real discovery trace. See REPORT.md "Cuts".
 */

export const CLOSE_SUB_ACCOUNT_PARAM_MAPPINGS: ParamMapping[] = [
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
    description: "The member who owns the sub-account to close.",
  },
];

export const CLOSE_SUB_ACCOUNT_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "closed successfully",
  description: "The sub-account-closed confirmation banner is visible.",
};

export const CLOSE_SUB_ACCOUNT_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "member_not_found",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "No member found with ID", description: "Search returned no matching member." },
    description: "No member exists with the given memberId. A legitimate result, not a crash.",
  },
  {
    name: "already_closed",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "already", description: "The close-confirmation page reported the sub-account was already closed." },
    description: "This sub-account was already closed (e.g. by a previous run of this same artifact) -- a legitimate outcome, not a system error.",
  },
  {
    // Found live: with no sub-account to act on, step-7's "Close" click has no locator to
    // resolve at all -- a mechanical action failure, not a navigation to an unexpected page.
    // detectKnownOutcome() still runs on the CURRENT page after that failure (see
    // replay-engine.ts's executeStep), so this is reachable the same way any other outcome
    // is -- it just needed the right detector text for the member page's own empty state.
    name: "no_sub_account_to_close",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "No sub-accounts on file", description: "The member page itself shows no sub-accounts at all." },
    description: "This member has no sub-account to close. A legitimate result, not a crash.",
  },
];

/** The sub-account's own recorded step-level locator (its `:subId` in the URL/click target)
 *  is what actually pins down WHICH sub-account this artifact acts on -- there's no
 *  separate `subId` input param, because the click target that identifies the row IS the
 *  identifier, recorded exactly as discovery found it. A production version would want that
 *  to be a real input instead (see REPORT.md "Cuts" for the same class of limitation
 *  named for open-sub-account's literal-value step-11); noted here rather than glossed over. */
export function annotateCloseSubAccountCheckpoints(artifact: CapabilityArtifact): void {
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
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Close") || isClickNamed(s, "Close Account"), {
    kind: "url",
    expr: "/members/{memberId}/sub-accounts/*/close",
    description: "Reached the close-confirmation form for the sub-account.",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Confirm Close") || isClickNamed(s, "Confirm Closure"), {
    kind: "url",
    expr: "/members/{memberId}/sub-accounts/*/closed",
    description: "Reached the sub-account-closed confirmation page.",
  });
}
