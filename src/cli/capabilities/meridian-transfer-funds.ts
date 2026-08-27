import type { ArtifactStep, CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Second capability against MERIDIAN CORE, and minimum-bar #2 from the brief: an
 * irreversible write (from-share, to-share, amount, memo -> review -> post), unlike
 * check-balance's read. Field names again come from dom-scan.ts's `labelForInput()` falling
 * back to raw HTML `name` attributes (no `<label>` on this target) -- "from"/"to"/"amount"/
 * "memo", not the visible "From Share:"/"To Share:" copy.
 *
 * Deliberately NO `session_timeout` KnownOutcome here, unlike meridian-check-balance.ts --
 * this is the load-bearing safety decision for this capability, not an oversight. If the
 * session dies mid-review/post, the in-progress transaction's own per-request `_token` and
 * page context are gone; blindly re-authenticating and "retrying the current step" would
 * click a target that no longer exists, or worse, resubmit a stale, partially-applied
 * financial transaction. Leaving this UNDETECTED means a session-timeout here mechanically
 * fails to find its target element, matches no known outcome, and falls through to
 * `replay-engine.ts`'s generic hard-failure path -- which (unlike a KnownOutcome explicitly
 * categorized `hard_failure`, which returns a failure directly) is the path that actually
 * calls `tryEscalate`. That's the intended, safety-conscious behavior for a write action:
 * stop and hand it to a human, don't guess.
 */

export const MERIDIAN_TRANSFER_FUNDS_PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "operator", paramName: "username", type: "string", description: "Operator ID used to sign on." },
  { role: "textbox", name: "password", paramName: "password", type: "string", sensitive: true, description: "Operator password used to sign on." },
  { role: "combobox", name: "branch", paramName: "branch", type: "string", description: "Branch to sign on at (e.g. MAIN-001)." },
  { role: "textbox", name: "q", paramName: "memberId", type: "string", description: "The member whose shares to transfer between." },
  {
    role: "combobox",
    name: "from",
    paramName: "fromShare",
    type: "string",
    description: "Exact share id to move funds OUT of, e.g. \"100234-S0001\" -- MERIDIAN identifies shares by id, not a fixed checking/savings pair.",
  },
  {
    role: "combobox",
    name: "to",
    paramName: "toShare",
    type: "string",
    description: "Exact share id to move funds INTO, e.g. \"100234-S0070\".",
  },
  { role: "textbox", name: "amount", paramName: "amount", type: "string", description: "Dollar amount to transfer. Plain numeric value, no currency symbol." },
  { role: "textbox", name: "memo", paramName: "memo", type: "string", required: false, description: "Optional memo text for this transfer." },
];

export const MERIDIAN_TRANSFER_FUNDS_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "TRANSFER POSTED",
  description: "The transfer confirmation banner is visible, with a real confirmation number.",
};

export const MERIDIAN_TRANSFER_FUNDS_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "insufficient_funds",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "Insufficient available balance", description: "The source share doesn't have enough available balance." },
    description: "The source share's balance is lower than the requested transfer amount -- a legitimate business outcome, not a system error.",
  },
  {
    name: "source_share_on_hold",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "is HOLD and cannot be debited", description: "The source share has an active account hold." },
    description: "The source share is on HOLD and cannot be debited -- a legitimate business outcome, not a system error.",
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
    description: "The host reported a transient maintenance window; safe to retry the same step once -- this occurs before the irreversible /post step commits anything.",
    recovery: "retry_step",
  },
  {
    name: "application_error",
    category: "recoverable",
    detector: { kind: "text_match", expr: "APPLICATION ERROR", description: "A transient hard-application-error interstitial (natural or ?inject=server)." },
    description: "The host reported an unexpected application error; safe to retry the same step once.",
    recovery: "retry_step",
  },
];

/** Attaches milestone checkpoints. The transfer form's own link text ("Funds Transfer") and
 *  each stage's submit button text ("Continue" on the form, "Post Transfer" on the review
 *  page) are genuinely distinct, so matching on the FULL description avoids the ambiguity a
 *  shared label would cause (same reasoning as every other capability's annotate function). */
export function annotateMeridianTransferFundsCheckpoints(artifact: CapabilityArtifact): void {
  const isClickNamed = (step: ArtifactStep, name: string) => step.actionType === "click" && step.description.includes(`"${name}"`);

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
  // A real bug caught live via replay, not guessed: clicking "Funds Transfer" from the
  // Main Menu (rather than a plain member-record view) goes through `/members?next=transfer`
  // -- confirmed by recon -- so selecting a member here lands DIRECTLY on the transfer
  // FORM, not the plain member-record page. The originally-attached checkpoint expected
  // "/members/{memberId}" (2 path segments) against an actual 3-segment landing URL, which
  // `matchUrlTemplate`'s segment-count check correctly rejects -- caught by a real replay,
  // not discovery, since checkpoints are attached as metadata after the fact and never
  // re-verified against the live page until replay actually runs them.
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Select"), {
    kind: "url",
    expr: "/members/{memberId}/transfer",
    description: "Reached the transfer form directly (via the Main Menu's Funds Transfer shortcut).",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Continue"), {
    kind: "url",
    expr: "/members/{memberId}/transfer/review",
    description: "Reached the transfer review/confirmation page.",
  });
}
