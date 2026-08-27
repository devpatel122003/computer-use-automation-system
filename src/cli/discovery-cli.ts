import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { DiscoveryAgent } from "../agent/discovery-agent.js";
import { EscalationController } from "../escalation/controller.js";
import { buildArtifact, type RecorderOptions } from "../artifact/recorder.js";
import { getOrCreateEntry, loadRegistry, saveRegistry } from "../artifact/registry.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

/**
 * Every `run-agent-*.ts` entry point (one per capability, across both mock-bank and
 * MERIDIAN) used to repeat this exact sequence -- parse-args-computed goal/credentials in,
 * then identical launch/discover/build/save/register logic out -- with only strings and a
 * handful of extra param names actually differing between files. Extracted once real
 * duplication was pointed out (not speculative: a real diff between two of these files
 * showed the entire post-parse-args body was byte-for-byte identical control flow). Each
 * `run-agent-*.ts` file now only computes its own defaults/goal text and calls this.
 */
export interface DiscoveryCliConfig extends RecorderOptions {
  /** Registered as this discovery/escalation run's capability id -- almost always the same
   *  string as `id` above, kept separate because a couple of existing entry points pass a
   *  slightly different escalation label than the artifact id. */
  capabilityId: string;
  annotate?: (artifact: CapabilityArtifact) => void;
  goal: string;
  startUrl: string;
  /** The operator password actually used for this run -- registered as a redacted value
   *  before any logging happens, since the goal text itself embeds it so the model can
   *  type it. */
  password: string;
  artifactOut: string;
  registryPath: string;
  headed: boolean;
}

export async function runDiscoveryCli(config: DiscoveryCliConfig): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Export it or add it to a .env file (see README.md).");
    process.exit(1);
  }

  const runId = newRunId("discovery");
  const logger = new EvidenceLogger({ runId, runType: "discovery" });
  logger.addSensitiveValue(config.password);
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed: config.headed });

  try {
    await surface.launch(config.startUrl);

    const policy = new GuardrailsPolicy();
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const escalation = new EscalationController(surface.getPage(), logger, runId, "discovery", config.capabilityId);

    const agent = new DiscoveryAgent({
      surface,
      policy,
      logger,
      genai,
      onRiskyAction: async ({ reason }) => escalation.confirmRiskyAction(reason),
      onEscalate: async ({ step, reason }) => escalation.requestIntervention({ step, reason }),
    });

    console.log(`Discovery run: ${runId}`);
    console.log(`Goal: ${config.goal}\n`);

    const result = await agent.run(config.goal, config.startUrl);
    logger.writeJson("discovery-result.json", result);

    console.log(`\nDiscovery finished with status: ${result.status}`);
    if (result.finalSummary) console.log(`Summary: ${result.finalSummary}`);
    if (result.escalationReason) console.log(`Escalation reason: ${result.escalationReason}`);
    if (Object.keys(result.outputs).length > 0) console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
    console.log(`Evidence written to: ${logger.runDir}`);

    if (result.status === "finished") {
      const artifact = buildArtifact(result, {
        id: config.id,
        name: config.name,
        description: config.description,
        version: config.version,
        appId: config.appId,
        baseUrlPattern: config.baseUrlPattern,
        paramMappings: config.paramMappings,
        successCheckpoint: config.successCheckpoint,
        knownOutcomes: config.knownOutcomes,
      });
      config.annotate?.(artifact);

      fs.mkdirSync(path.dirname(config.artifactOut), { recursive: true });
      fs.writeFileSync(config.artifactOut, JSON.stringify(artifact, null, 2));
      console.log(`\nArtifact written to: ${config.artifactOut}`);

      const registry = loadRegistry(config.registryPath);
      const entry = getOrCreateEntry(registry, artifact);
      saveRegistry(config.registryPath, registry);
      console.log(`Registered as "${entry.approvalState}" in ${config.registryPath} (fingerprint ${entry.fingerprint}).`);
      console.log(`Run \`npm run approve -- --artifact ${config.artifactOut} --registry ${config.registryPath}\` once reviewed.`);
    } else {
      console.log("\nNo artifact recorded (discovery did not finish successfully).");
    }
  } finally {
    await surface.close();
  }
}
