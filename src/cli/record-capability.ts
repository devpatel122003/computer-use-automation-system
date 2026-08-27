import "dotenv/config";
import fs from "node:fs";
import { z } from "zod";
import { CheckpointSchema, KnownOutcomeSchema, type CapabilityArtifact, type ArtifactStep } from "../artifact/schema.js";
import { attachStepCheckpoint, isClickMatching, isClickNamed, type ParamMapping } from "../artifact/recorder.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

/**
 * The config-driven counterpart to the dozen hand-written run-agent-*.ts files (one per
 * capability, split across mock-bank and MERIDIAN). Every one of those reduces to the same
 * thing: parse-args-computed goal/credentials in, then an identical
 * launch/discover/build/save/register call into runDiscoveryCli() out, differing only in the
 * domain-knowledge fields (param mappings, the success checkpoint, known outcomes, and which
 * steps get which intermediate checkpoint). This script reads that domain knowledge from one
 * JSON file instead of requiring a new .ts wrapper (and usually a new src/cli/capabilities/
 * *.ts file) per capability -- see config/capability-configs/*.example.json for two configs
 * that reproduce existing, already-approved artifacts field-for-field, and
 * docs/26-recording-new-capabilities.md for the field-by-field guide.
 *
 * What this deliberately does NOT automate: paramMappings/successCheckpoint/knownOutcomes
 * are still domain knowledge a human writes after reading one real discovery trace, the same
 * way recorder.ts's own doc comment explains why that's authored rather than inferred from
 * the (happy-path-only) trace itself. This script only removes the need to write a new
 * source file to hold that knowledge -- it does not remove the need to know it.
 *
 * Every existing checkpoint-annotation function in src/cli/capabilities/*.ts reduces to the
 * same two primitives (attachStepCheckpoint + isClickNamed/isClickMatching) -- confirmed by
 * reading all twelve of them, not assumed -- so `checkpointAnnotations` below covers the
 * annotate step generically with no loss of expressiveness against real, shipped examples.
 */

const ParamMappingSchema = z.object({
  role: z.string(),
  name: z.string(),
  paramName: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  sensitive: z.boolean().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

const CheckpointAnnotationSchema = z.object({
  /** Every step matching ANY of these names gets this checkpoint attached (first match, same
   *  semantics as attachStepCheckpoint's own "find" -- only the first matching step is
   *  annotated per rule, matching every existing hand-written annotate function's behavior). */
  matchClickNames: z.array(z.string()).min(1),
  /** "exact" -> isClickNamed (the step's own description must contain `"Name"` verbatim).
   *  "matching" -> isClickMatching (case-insensitive substring) -- for control copy that
   *  varies slightly from what discovery happened to record. Defaults to "exact", matching
   *  most existing capabilities. */
  matchMode: z.enum(["exact", "matching"]).default("exact"),
  checkpoint: CheckpointSchema,
});

const CapabilityConfigSchema = z.object({
  id: z.string(),
  /** Defaults to `id` -- only a couple of existing entry points use a distinct escalation
   *  label, so this stays optional rather than forcing every config to repeat `id` twice. */
  capabilityId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  version: z.string().default("1.0.0"),
  appId: z.string(),
  baseUrlPattern: z.string(),
  goal: z.string(),
  startUrl: z.string(),
  password: z.string(),
  artifactOut: z.string(),
  registryPath: z.string(),
  paramMappings: z.array(ParamMappingSchema),
  successCheckpoint: CheckpointSchema,
  knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  checkpointAnnotations: z.array(CheckpointAnnotationSchema).default([]),
});

export type CapabilityConfig = z.infer<typeof CapabilityConfigSchema>;

/** Compiles `checkpointAnnotations` into the exact same shape every hand-written
 *  annotate*Checkpoints function already has: a plain function over the built artifact,
 *  calling attachStepCheckpoint once per rule. Returns undefined (not a no-op function) for
 *  an empty list, matching DiscoveryCliConfig's own `annotate?` being optional. */
export function buildAnnotate(annotations: CapabilityConfig["checkpointAnnotations"]): ((artifact: CapabilityArtifact) => void) | undefined {
  if (annotations.length === 0) return undefined;
  return (artifact: CapabilityArtifact) => {
    for (const rule of annotations) {
      const matchOne = (step: ArtifactStep, name: string) => (rule.matchMode === "matching" ? isClickMatching(step, name) : isClickNamed(step, name));
      attachStepCheckpoint(artifact, (step) => rule.matchClickNames.some((name) => matchOne(step, name)), rule.checkpoint);
    }
  };
}

export function loadCapabilityConfig(configPath: string): CapabilityConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const parsed = CapabilityConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid capability config at ${configPath}:\n${JSON.stringify(parsed.error.format(), null, 2)}`);
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config;
  if (!configPath) {
    console.error(
      "Usage: npm run record-capability -- --config <path-to-config.json> " +
        "[--goal '...'] [--start-url <url>] [--artifact-out <path>] [--headless true]"
    );
    process.exit(1);
    return;
  }

  const config = loadCapabilityConfig(configPath);

  const goal = args.goal ?? config.goal;
  const startUrl = args["start-url"] ?? config.startUrl;
  const artifactOut = args["artifact-out"] ?? config.artifactOut;
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: config.id,
    capabilityId: config.capabilityId ?? config.id,
    name: config.name,
    description: config.description,
    version: config.version,
    appId: config.appId,
    baseUrlPattern: config.baseUrlPattern,
    paramMappings: config.paramMappings as ParamMapping[],
    successCheckpoint: config.successCheckpoint,
    knownOutcomes: config.knownOutcomes,
    annotate: buildAnnotate(config.checkpointAnnotations),
    goal,
    startUrl,
    password: config.password,
    artifactOut,
    registryPath: config.registryPath,
    headed,
  });
}

// Guarded so importing loadCapabilityConfig/buildAnnotate from a test doesn't also try to
// run discovery -- same convention as src/chat-ui/server.ts's own VITEST guard.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
