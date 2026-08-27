import type { ArtifactStep, CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Fourth capability against MERIDIAN CORE: "Open New Share" -- write, review->post, same
 * shape as meridian-transfer-funds.ts (confirmed live via curl recon). Field names again
 * come from dom-scan.ts's `labelForInput()` falling back to raw HTML `name` attributes
 * (no `<label>` on this target) -- "type"/"deposit", not the visible "Share Type:"/
 * "Initial Deposit:" copy.
 *
 * Deliberately NO `session_timeout` KnownOutcome here, same reasoning as
 * meridian-transfer-funds.ts: a mid-flow session death should fall through to the generic
 * hard-failure path (which calls `tryEscalate`), not attempt to blindly resubmit a
 * partially-applied share-opening transaction against a stale `_token`.
 */

export const MERIDIAN_OPEN_SHARE_PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "operator", paramName: "username", type: "string", description: "Operator ID used to sign on." },
  { role: "textbox", name: "password", paramName: "password", type: "string", sensitive: true, description: "Operator password used to sign on." },
  { role: "combobox", name: "branch", paramName: "branch", type: "string", description: "Branch to sign on at (e.g. MAIN-001)." },
  { role: "textbox", name: "q", paramName: "memberId", type: "string", description: "The member to open the new share for." },
  {
    role: "combobox",
    name: "type",
    paramName: "shareType",
    type: "string",
    description: 'Share type code to open: "S0001" (Regular Shares), "S0070" (Share Draft/Checking), "MMKT" (Money Market), or "CERT" (Certificate).',
  },
  {
    role: "textbox",
    name: "deposit",
    paramName: "deposit",
    type: "string",
    description: "Initial deposit amount. Plain numeric value, no currency symbol. Certificates require a $500.00 minimum.",
  },
];

export const MERIDIAN_OPEN_SHARE_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "text_match",
  expr: "NEW SHARE ESTABLISHED",
  description: "The share-opened confirmation banner is visible, with a real confirmation number and new share id.",
};

export const MERIDIAN_OPEN_SHARE_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "validation_rejected_business",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "could not be validated", description: "MERIDIAN's own field-level validation message (e.g. certificate minimum-deposit rule)." },
    description: "The requested share/deposit combination failed a real business rule (e.g. certificate minimum opening deposit of $500.00) -- a legitimate business outcome, not a system error.",
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

/** Attaches milestone checkpoints, same pattern/reasoning as every other MERIDIAN capability. */
export function annotateMeridianOpenShareCheckpoints(artifact: CapabilityArtifact): void {
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
  // Same real shape as meridian-transfer-funds.ts's "Select" checkpoint: the Main Menu's
  // "Open New Share" link goes through `/members?next=open-share`, so selecting a member
  // here lands DIRECTLY on the open-share FORM, not the plain member-record page.
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Select"), {
    kind: "url",
    expr: "/members/{memberId}/open-share",
    description: "Reached the open-share form directly (via the Main Menu's Open New Share shortcut).",
  });
  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Continue"), {
    kind: "url",
    expr: "/members/{memberId}/open-share/review",
    description: "Reached the open-share review/confirmation page.",
  });
}
