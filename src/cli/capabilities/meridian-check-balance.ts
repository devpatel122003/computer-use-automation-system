import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * First capability recorded against MERIDIAN CORE (the Adaptation Project's real, live
 * target -- see REPORT.md and docs for the full story). Read-only, mirrors mock-bank's own
 * `check-balance` capability in shape but not in field names: MERIDIAN's table-layout forms
 * have no `<label for>` association at all (confirmed live), so `dom-scan.ts`'s
 * `labelForInput()` falls back to each field's raw HTML `name` attribute -- "operator" /
 * "password" / "branch" / "q" -- not the visible "Operator ID:"/"Branch:" copy on screen.
 * That's a real, disclosed consequence of this target's "no clean component boundaries" by
 * design, not a guess.
 */

export const MERIDIAN_CHECK_BALANCE_PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "operator", paramName: "username", type: "string", description: "Operator ID used to sign on." },
  { role: "textbox", name: "password", paramName: "password", type: "string", sensitive: true, description: "Operator password used to sign on." },
  { role: "combobox", name: "branch", paramName: "branch", type: "string", description: "Branch to sign on at (e.g. MAIN-001)." },
  { role: "textbox", name: "q", paramName: "memberId", type: "string", description: "The member number to look up." },
];

export const MERIDIAN_CHECK_BALANCE_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "url",
  expr: "/members/{memberId}",
  description: "Reached the member record page.",
};

// A real adaptation decision, not an oversight: confirmed live across all 5 seed members
// that the SHARES/BALANCES table's row count and row-2-onward composition varies member to
// member (one has a Certificate second, another Money Market, another Checking) -- only the
// very first row is consistent (always that member's Regular Shares account). A rigid,
// per-row-typed output schema (mirroring mock-bank's fixed checking/savings pair) doesn't
// honestly fit MERIDIAN's variable share list. This capability's structured output is
// therefore scoped to the member's name plus that one reliably-first-row balance/status --
// the full itemized share list stays visible in this run's own evidence (screenshot + page
// text), not force-fit into a typed field. Named plainly as a cut in the write-up.

export const MERIDIAN_CHECK_BALANCE_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "member_not_found",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "No member records matched your search", description: "The search step itself returned no matches." },
    description: "No member exists with the given member number. A legitimate result, not a crash.",
  },
  {
    name: "validation_rejected",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "TRANSACTION REJECTED", description: "MERIDIAN's own validation-fault interstitial (?inject=validation)." },
    description: "The request was rejected as malformed by the target app.",
  },
  {
    name: "record_not_found",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "RECORD NOT FOUND", description: "MERIDIAN's own not-found interstitial (natural 404, or ?inject=notfound)." },
    description: "The member record could not be located on the host.",
  },
  {
    name: "permission_denied",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "SUPERVISOR OVERRIDE REQUIRED", description: "MERIDIAN's own permission-fault interstitial (?inject=permission)." },
    description: "The signed-on operator is not authorized for this function.",
  },
  {
    name: "maintenance",
    category: "recoverable",
    detector: { kind: "text_match", expr: "SCHEDULED MAINTENANCE IN PROGRESS", description: "A transient maintenance interstitial (natural or ?inject=maintenance)." },
    description: "The host reported a transient maintenance window; safe to retry the same step once.",
    recovery: "retry_step",
  },
  {
    name: "application_error",
    category: "recoverable",
    detector: { kind: "text_match", expr: "APPLICATION ERROR", description: "A transient hard-application-error interstitial (natural or ?inject=server)." },
    description: "The host reported an unexpected application error; safe to retry the same step once (a read has no side effects to duplicate).",
    recovery: "retry_step",
  },
  {
    name: "session_timeout",
    category: "recoverable",
    detector: { kind: "text_match", expr: "YOUR SESSION HAS TIMED OUT", description: "The session was destroyed mid-flow (natural idle timeout, or ?inject=timeout)." },
    description:
      "The operator session expired mid-flow. Safe to re-authenticate and retry for this READ-ONLY capability specifically -- " +
      "re-running sign-on and re-issuing the same lookup has no side effects. (Write capabilities against this target deliberately do NOT " +
      "get this same recovery -- see meridian-transfer-funds.ts's own doc comment for why.)",
    recovery: "reauthenticate_and_retry_step",
    recoveryStepIds: ["step-1", "step-2", "step-3", "step-4", "step-5"],
  },
];

/** Attaches the one real milestone this flow has before the final success checkpoint --
 *  reaching the search page after signing on -- and the member_not_found detector right
 *  after the search submit, so a genuine no-match is classified there instead of the next
 *  step failing to find a "Select" link that was never rendered. */
export function annotateMeridianCheckBalanceCheckpoints(artifact: CapabilityArtifact): void {
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Sign On"), {
    kind: "url",
    expr: "/menu",
    description: "Reached the main menu after signing on.",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Search"), {
    kind: "url",
    expr: "/members",
    description: "Reached the member search results page.",
  });
}
