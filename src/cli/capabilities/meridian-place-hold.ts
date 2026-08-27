import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Sixth and last capability against MERIDIAN CORE: "Place Account Hold" -- write,
 * review->post, supervisor-gated. Confirmed live via curl recon: the GET form itself is
 * reachable by any operator (200 for teller1 too), but `POST .../hold/review` returns a
 * real 403 "SUPERVISOR OVERRIDE REQUIRED" for a non-supervisor -- recorded here as a
 * `business_outcome` (the target app's own real authorization response), not a guardrail
 * block. This capability MUST be recorded with `super1` (supervisor) credentials, since
 * discovery needs the restricted action to actually succeed to reach the real success
 * checkpoint; the teller1-vs-403 case is exercised at replay/demo time instead, as the
 * brief's own "clean exceptional state" example.
 *
 * Deliberately NO `session_timeout` KnownOutcome here, same reasoning as the other write
 * capabilities (transfer/open-share/update): a mid-flow session death should fall through
 * to the generic hard-failure path (which calls `tryEscalate`), not attempt to blindly
 * resubmit an irreversible hold against a stale `_token`.
 */

export const MERIDIAN_PLACE_HOLD_PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "operator", paramName: "username", type: "string", description: "Operator ID used to sign on. Must be a supervisor (e.g. \"super1\") for this action to succeed." },
  { role: "textbox", name: "password", paramName: "password", type: "string", sensitive: true, description: "Operator password used to sign on." },
  { role: "combobox", name: "branch", paramName: "branch", type: "string", description: "Branch to sign on at (e.g. MAIN-001)." },
  { role: "textbox", name: "q", paramName: "memberId", type: "string", description: "The member whose share to place on hold." },
  {
    role: "combobox",
    name: "share",
    paramName: "shareId",
    type: "string",
    description: "Exact share id to place on hold, e.g. \"101555-CERT\" -- MERIDIAN identifies shares by id, not a fixed checking/savings pair.",
  },
  {
    role: "combobox",
    name: "reason",
    paramName: "reasonCode",
    type: "string",
    description: 'Reason code for the hold: "FRAUD" (suspected fraud), "LEGAL" (legal / levy), or "DECEASED" (member deceased).',
  },
  { role: "textbox", name: "notes", paramName: "notes", type: "string", required: false, description: "Optional free-text notes for this hold." },
];

export const MERIDIAN_PLACE_HOLD_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "HOLD RECORDED",
  description: "The hold-applied confirmation banner is visible, with a real confirmation number.",
};

export const MERIDIAN_PLACE_HOLD_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "supervisor_override_required",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "SUPERVISOR OVERRIDE REQUIRED", description: "MERIDIAN's own real authorization response for a non-supervisor operator attempting this restricted action." },
    description: "The signed-on operator is not a supervisor -- a legitimate business outcome (the target app's own real access-control decision), not a system error or guardrail block.",
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

/** Attaches milestone checkpoints, same pattern/reasoning as every other MERIDIAN capability. */
export function annotateMeridianPlaceHoldCheckpoints(artifact: CapabilityArtifact): void {
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
  // Same real shape as the other Main Menu shortcuts: the Main Menu's "Place Account Hold"
  // link goes through `/members?next=hold`, so selecting a member here lands DIRECTLY on
  // the hold form.
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Select"), {
    kind: "url",
    expr: "/members/{memberId}/hold",
    description: "Reached the account-hold form directly (via the Main Menu's Place Account Hold shortcut).",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Continue"), {
    kind: "url",
    expr: "/members/{memberId}/hold/review",
    description: "Reached the account-hold review/confirmation page.",
  });
}
