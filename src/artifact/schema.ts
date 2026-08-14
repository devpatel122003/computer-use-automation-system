import { z } from "zod";

/**
 * A capability artifact is a typed, versioned, agent-invocable contract -- not just a
 * step list. See REPORT.md "Artifact schema" for the reasoning behind each field.
 */

export const LocatorStrategySchema = z.enum(["test_id", "role", "text", "css_structural"]);

export const ElementRoleSchema = z.enum(["button", "link", "textbox", "combobox", "checkbox", "radio", "text"]);

export const LocatorCandidateSchema = z.object({
  strategy: LocatorStrategySchema,
  role: ElementRoleSchema.optional(),
  name: z.string().optional(),
  testId: z.string().optional(),
  cssPath: z.string().optional(),
  nth: z.number().int().min(0),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string(),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

/** A step input is either a literal value or a reference to a declared input param. */
export const StepInputSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ paramRef: z.string() }),
]);
export type StepInput = z.infer<typeof StepInputSchema>;

export const CheckpointSchema = z.object({
  kind: z.enum(["url", "element_visible", "text_match"]),
  /**
   * For "url": a path template, segments are literal, "{paramName}" (substituted from
   * inputParams at replay time), or "*" (matches any single segment).
   * For "element_visible": a locator candidate chain, JSON-encoded, that must resolve.
   * For "text_match": a case-insensitive substring that must appear somewhere on the page.
   */
  expr: z.string(),
  description: z.string(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const WaitPolicySchema = z.object({
  timeoutMs: z.number().int().positive().default(5000),
  retries: z.number().int().min(0).default(0),
});

export const ActionTypeSchema = z.enum(["navigate", "click", "type", "select_option", "extract"]);

export const ArtifactStepSchema = z.object({
  id: z.string(),
  actionType: ActionTypeSchema,
  /** Human-readable, e.g. "Click the Sign On button" -- for reviewers, not executed. */
  description: z.string(),
  url: z.string().optional(),
  locator: z.array(LocatorCandidateSchema).optional(),
  input: StepInputSchema.optional(),
  /** For "extract" steps: which output_schema field this feeds. */
  outputName: z.string().optional(),
  checkpoint: CheckpointSchema.optional(),
  risk: z.enum(["safe", "risky"]),
  waitPolicy: WaitPolicySchema,
});
export type ArtifactStep = z.infer<typeof ArtifactStepSchema>;

export const InputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  sensitive: z.boolean().default(false),
  description: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  sourceStepId: z.string(),
  description: z.string().optional(),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

export const KnownOutcomeSchema = z.object({
  name: z.string(),
  category: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  detector: CheckpointSchema,
  description: z.string(),
  /** Only meaningful for category "recoverable". */
  recovery: z.enum(["reauthenticate_and_retry_step", "retry_step"]).optional(),
  /** For "reauthenticate_and_retry_step": step ids to re-run first (e.g. the login steps). */
  recoveryStepIds: z.array(z.string()).optional(),
});
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

export const CapabilityArtifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  createdAt: z.string(),
  target: z.object({
    appId: z.string(),
    surfaceType: z.literal("web"),
    /** Not a concrete URL -- overridden per tenant/environment, never baked into steps. */
    baseUrlPattern: z.string(),
  }),
  inputParams: z.array(InputParamSchema),
  outputSchema: z.array(OutputFieldSchema),
  steps: z.array(ArtifactStepSchema),
  successCheckpoint: CheckpointSchema,
  knownOutcomes: z.array(KnownOutcomeSchema),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
