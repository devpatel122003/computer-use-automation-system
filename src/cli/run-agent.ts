import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { GuardrailsPolicy } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { DiscoveryAgent } from "../agent/discovery-agent.js";
import { EscalationController } from "../escalation/controller.js";
import { buildArtifact } from "../artifact/recorder.js";
import { getOrCreateEntry, loadRegistry, saveRegistry } from "../artifact/registry.js";
import { parseArgs } from "./args.js";
import {
  OPEN_SUB_ACCOUNT_KNOWN_OUTCOMES,
  OPEN_SUB_ACCOUNT_PARAM_MAPPINGS,
  OPEN_SUB_ACCOUNT_SUCCESS_CHECKPOINT,
  annotateOpenSubAccountCheckpoints,
} from "./capabilities/open-sub-account.js";

const DEFAULT_USERNAME = "demo_operator";
const DEFAULT_PASSWORD = "demo_password";

function buildDefaultGoal(username: string, password: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}", look up member 10001, ` +
    "open a new Savings sub-account with an initial deposit of $100, and reach the confirmation screen."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const goal = args.goal ?? buildDefaultGoal(username, password);
  const startUrl = args["start-url"] ?? "http://localhost:4000/login";
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts/open-sub-account.artifact.json";
  const headed = args.headless !== "true";

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Export it or add it to a .env file (see README.md).");
    process.exit(1);
  }

  const runId = newRunId("discovery");
  const logger = new EvidenceLogger({ runId, runType: "discovery" });
  // Register before any logging happens: the goal text itself embeds the password (so the
  // model can type it), so redaction must be armed before the very first log call, not
  // just when the discovery loop later observes the password field.
  logger.addSensitiveValue(password);
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });
  await surface.launch(startUrl);

  const policy = new GuardrailsPolicy();
  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const escalation = new EscalationController(surface.getPage(), logger, runId, "discovery", "open-sub-account");

  const agent = new DiscoveryAgent({
    surface,
    policy,
    logger,
    genai,
    onRiskyAction: async ({ reason }) => escalation.confirmRiskyAction(reason),
    onEscalate: async ({ step, reason }) => escalation.requestIntervention({ step, reason }),
  });

  console.log(`Discovery run: ${runId}`);
  console.log(`Goal: ${goal}\n`);

  const result = await agent.run(goal, startUrl);
  logger.writeJson("discovery-result.json", result);

  console.log(`\nDiscovery finished with status: ${result.status}`);
  if (result.finalSummary) console.log(`Summary: ${result.finalSummary}`);
  if (result.escalationReason) console.log(`Escalation reason: ${result.escalationReason}`);
  if (Object.keys(result.outputs).length > 0) console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
  console.log(`Evidence written to: ${logger.runDir}`);

  if (result.status === "finished") {
    const artifact = buildArtifact(result, {
      id: "open-sub-account",
      name: "Open Sub-Account",
      description:
        "Signs on, looks up a member by ID, opens a new sub-account with a specified type and initial deposit, and confirms the result.",
      version: "1.0.0",
      appId: "mock-bank",
      baseUrlPattern: "http://localhost:4000",
      paramMappings: OPEN_SUB_ACCOUNT_PARAM_MAPPINGS,
      successCheckpoint: OPEN_SUB_ACCOUNT_SUCCESS_CHECKPOINT,
      knownOutcomes: OPEN_SUB_ACCOUNT_KNOWN_OUTCOMES,
    });
    annotateOpenSubAccountCheckpoints(artifact);

    fs.mkdirSync(path.dirname(artifactOut), { recursive: true });
    fs.writeFileSync(artifactOut, JSON.stringify(artifact, null, 2));
    console.log(`\nArtifact written to: ${artifactOut}`);

    // Confidence & approval (Section 8 stretch goal): a freshly recorded artifact always
    // starts in "draft" -- unattended replay isn't trusted until a human runs `approve`.
    const registryPath = "evidence/artifacts/registry.json";
    const registry = loadRegistry(registryPath);
    const entry = getOrCreateEntry(registry, artifact);
    saveRegistry(registryPath, registry);
    console.log(`Registered as "${entry.approvalState}" in ${registryPath} (fingerprint ${entry.fingerprint}).`);
    console.log(`Run \`npm run approve -- --artifact ${artifactOut}\` once you've reviewed it and are ready to allow unattended replay.`);
  } else {
    console.log("\nNo artifact recorded (discovery did not finish successfully).");
  }

  await surface.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
