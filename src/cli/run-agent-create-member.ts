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
  CREATE_MEMBER_KNOWN_OUTCOMES,
  CREATE_MEMBER_PARAM_MAPPINGS,
  CREATE_MEMBER_SUCCESS_CHECKPOINT,
  annotateCreateMemberCheckpoints,
} from "./capabilities/create-member.js";

/**
 * The second real capability this system records, not a variation on the first: enrolling
 * a brand new member, rather than acting on one that already exists. Mirrors run-agent.ts
 * exactly (same discovery loop, same guardrails, same evidence discipline) -- a second
 * dedicated CLI rather than a flag on run-agent.ts, the same way escalation-resume-demo.ts
 * and escalation-resume-replay-demo.ts stayed separate scripts rather than growing one
 * script two unrelated modes.
 */

const DEFAULT_USERNAME = "demo_operator";
const DEFAULT_PASSWORD = "demo_password";

function buildDefaultGoal(username: string, password: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}", then enroll a brand new ` +
    'member named "Jordan Lee" with an initial checking deposit of $500 and an initial ' +
    "savings deposit of $200, and once you reach the confirmation screen, extract and " +
    "report the new member's ID."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const goal = args.goal ?? buildDefaultGoal(username, password);
  const startUrl = args["start-url"] ?? "http://localhost:4000/login";
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts/create-member.artifact.json";
  const headed = args.headless !== "true";

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Export it or add it to a .env file (see README.md).");
    process.exit(1);
  }

  const runId = newRunId("discovery");
  const logger = new EvidenceLogger({ runId, runType: "discovery" });
  logger.addSensitiveValue(password);
  const surface = new PlaywrightSurface({ evidenceDir: logger.screenshotsDir, headed });

  try {
    await surface.launch(startUrl);

    const policy = new GuardrailsPolicy();
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const escalation = new EscalationController(surface.getPage(), logger, runId, "discovery", "create-member");

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
        id: "create-member",
        name: "Create Member",
        description: "Signs on and enrolls a brand new member with an initial checking and savings balance, then confirms the result.",
        version: "1.0.0",
        appId: "mock-bank",
        baseUrlPattern: "http://localhost:4000",
        paramMappings: CREATE_MEMBER_PARAM_MAPPINGS,
        successCheckpoint: CREATE_MEMBER_SUCCESS_CHECKPOINT,
        knownOutcomes: CREATE_MEMBER_KNOWN_OUTCOMES,
      });
      annotateCreateMemberCheckpoints(artifact);

      fs.mkdirSync(path.dirname(artifactOut), { recursive: true });
      fs.writeFileSync(artifactOut, JSON.stringify(artifact, null, 2));
      console.log(`\nArtifact written to: ${artifactOut}`);

      const registryPath = "evidence/artifacts/registry.json";
      const registry = loadRegistry(registryPath);
      const entry = getOrCreateEntry(registry, artifact);
      saveRegistry(registryPath, registry);
      console.log(`Registered as "${entry.approvalState}" in ${registryPath} (fingerprint ${entry.fingerprint}).`);
      console.log(`Run \`npm run approve -- --artifact ${artifactOut}\` once you've reviewed it and are ready to allow unattended replay.`);
    } else {
      console.log("\nNo artifact recorded (discovery did not finish successfully).");
    }
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
