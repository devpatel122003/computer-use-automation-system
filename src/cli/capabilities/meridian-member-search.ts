import type { ArtifactStep, CapabilityArtifact, Checkpoint, KnownOutcome } from "../../artifact/schema.js";
import { attachStepCheckpoint, type ParamMapping } from "../../artifact/recorder.js";

/**
 * Third capability against MERIDIAN CORE: "Member Inquiry / Selection" (search by member
 * number OR last name), a genuinely distinct real screen from the member RECORD page
 * meridian-check-balance reaches -- confirmed by recon: `/members` (this capability's own
 * destination) is a results LIST, `/members/:id` (check-balance's destination) is one
 * member's full record. Scoped to the first/only match's own Member No. + Name, mirroring
 * check-balance's own "don't force a variable-length list into a rigid schema" cut.
 */

export const MERIDIAN_MEMBER_SEARCH_PARAM_MAPPINGS: ParamMapping[] = [
  { role: "textbox", name: "operator", paramName: "username", type: "string", description: "Operator ID used to sign on." },
  { role: "textbox", name: "password", paramName: "password", type: "string", sensitive: true, description: "Operator password used to sign on." },
  { role: "combobox", name: "branch", paramName: "branch", type: "string", description: "Branch to sign on at (e.g. MAIN-001)." },
  {
    role: "combobox",
    name: "by",
    paramName: "searchBy",
    type: "string",
    description: 'Either "number" (search by exact member number) or "name" (search by last name).',
  },
  { role: "textbox", name: "q", paramName: "query", type: "string", description: "The member number or last name to search for." },
];

export const MERIDIAN_MEMBER_SEARCH_SUCCESS_CHECKPOINT: Checkpoint = {
  kind: "url",
  expr: "/members",
  description: "Reached the member search results page.",
};

export const MERIDIAN_MEMBER_SEARCH_KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    name: "no_matches",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "No member records matched your search", description: "The search returned zero results." },
    description: "No member matched the given search value. A legitimate result, not a crash.",
  },
  {
    name: "validation_rejected",
    category: "business_outcome",
    detector: { kind: "text_match", expr: "TRANSACTION REJECTED", description: "MERIDIAN's own validation-fault interstitial (?inject=validation)." },
    description: "The request was rejected as malformed by the target app.",
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
    description: "The host reported an unexpected application error; safe to retry the same step once.",
    recovery: "retry_step",
  },
  {
    name: "session_timeout",
    category: "recoverable",
    detector: { kind: "text_match", expr: "YOUR SESSION HAS TIMED OUT", description: "The session was destroyed mid-flow." },
    description: "The operator session expired mid-flow. Safe to re-authenticate and retry -- this is a read-only search, no side effects.",
    recovery: "reauthenticate_and_retry_step",
    recoveryStepIds: ["step-1", "step-2", "step-3", "step-4", "step-5"],
  },
];

export function annotateMeridianMemberSearchCheckpoints(artifact: CapabilityArtifact): void {
  const isClickNamed = (step: ArtifactStep, name: string) => step.actionType === "click" && step.description.includes(`"${name}"`);

  attachStepCheckpoint(artifact, (s) => isClickNamed(s, "Sign On"), {
    kind: "url",
    expr: "/menu",
    description: "Reached the main menu after signing on.",
  });
}
