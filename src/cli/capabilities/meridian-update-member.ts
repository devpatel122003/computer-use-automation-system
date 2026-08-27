import type { CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, isClickNamed, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Fifth capability against MERIDIAN CORE: "Update Member Information" -- a genuinely
 * different shape from transfer/open-share/hold, confirmed live via curl recon: `GET
 * /members/:id/update` (email/phone/address, pre-filled) posts DIRECTLY to `POST
 * /members/:id/update`, with no intermediate review/confirm step at all. There is no
 * "post" checkpoint step distinct from "the submit step" the way the other three writes
 * have -- the submit step IS the whole write.
 *
 * Deliberately NO `session_timeout` KnownOutcome here, same reasoning as the other write
 * capabilities: a mid-flow session death should fall through to the generic hard-failure
 * path (which calls `tryEscalate`), not attempt to blindly resubmit against a stale
 * `_token`.
 */

export const MERIDIAN_UPDATE_MEMBER_PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "operator", paramName: "username", type: "string", description: "Operator ID used to sign on." },
  { role: "textbox", name: "password", paramName: "password", type: "string", sensitive: true, description: "Operator password used to sign on." },
  { role: "combobox", name: "branch", paramName: "branch", type: "string", description: "Branch to sign on at (e.g. MAIN-001)." },
  { role: "textbox", name: "q", paramName: "memberId", type: "string", description: "The member whose contact information to update." },
  { role: "textbox", name: "email", paramName: "email", type: "string", description: "New e-mail address for the member." },
  { role: "textbox", name: "phone", paramName: "phone", type: "string", description: "New phone number for the member." },
  { role: "textbox", name: "address", paramName: "address", type: "string", description: "New mailing address for the member." },
];

export const MERIDIAN_UPDATE_MEMBER_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "CHANGES SAVED",
  description: "The update-saved confirmation banner is visible.",
};

export const MERIDIAN_UPDATE_MEMBER_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "invalid_email_format",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "not in a valid format", description: "MERIDIAN's own field-level validation message for a malformed e-mail address." },
    description: "The submitted e-mail address failed MERIDIAN's own format validation -- a legitimate business outcome, not a system error.",
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
    description: "The host reported a transient maintenance window; safe to retry the same step once -- this capability has no separate post step, so retrying re-submits the same, still-unapplied update.",
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

/** Attaches milestone checkpoints. No "review" checkpoint exists here -- genuinely absent
 *  from this capability's real shape, not an oversight (see file-level doc comment). */
export function annotateMeridianUpdateMemberCheckpoints(artifact: CapabilityArtifact): void {
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
  // Same real shape as the other Main Menu shortcuts (transfer, open-share): the Main
  // Menu's "Update Member Information" link goes through `/members?next=update`, so
  // selecting a member here lands DIRECTLY on the update FORM.
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Select"), {
    kind: "url",
    expr: "/members/{memberId}/update",
    description: "Reached the update-member form directly (via the Main Menu's Update Member Information shortcut).",
  });
}
