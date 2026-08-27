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
  MERIDIAN_MEMBER_SEARCH_KNOWN_OUTCOMES,
  MERIDIAN_MEMBER_SEARCH_PARAM_MAPPINGS,
  MERIDIAN_MEMBER_SEARCH_SUCCESS_CHECKPOINT,
  annotateMeridianMemberSearchCheckpoints,
} from "./capabilities/meridian-member-search.js";

const DEFAULT_USERNAME = "teller1";
const DEFAULT_PASSWORD = "password";
const DEFAULT_BRANCH = "MAIN-001";
const DEFAULT_START_URL = "https://web-sample.interface-hiring.com/signon";

function buildDefaultGoal(username: string, password: string, branch: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}" at branch "${branch}", then from the ` +
    'Main Menu choose Member Inquiry / Selection. Explicitly select "Member Number" in the "Search by" ' +
    'dropdown (even though it may already be selected -- choose it anyway, don\'t skip this step), then ' +
    'search for member number "100234", and once the results table appears, extract the Member No. shown in ' +
    'the first result row (store as "foundMemberId") and the Name shown in that same row (store as ' +
    '"foundMemberName"). Do not click Select or navigate any further.'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const goal = args.goal ?? buildDefaultGoal(username, password, branch);
  const startUrl = args["start-url"] ?? DEFAULT_START_URL;
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts-meridian/meridian-member-search.artifact.json";
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
    const escalation = new EscalationController(surface.getPage(), logger, runId, "discovery", "meridian-member-search");

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
        id: "meridian-member-search",
        name: "MERIDIAN: Member Search",
        description: "Signs on to MERIDIAN CORE and searches for a member by number or last name, reporting the first match.",
        version: "1.0.0",
        appId: "meridian-core",
        baseUrlPattern: "https://web-sample.interface-hiring.com",
        paramMappings: MERIDIAN_MEMBER_SEARCH_PARAM_MAPPINGS,
        successCheckpoint: MERIDIAN_MEMBER_SEARCH_SUCCESS_CHECKPOINT,
        knownOutcomes: MERIDIAN_MEMBER_SEARCH_KNOWN_OUTCOMES,
      });
      annotateMeridianMemberSearchCheckpoints(artifact);

      fs.mkdirSync(path.dirname(artifactOut), { recursive: true });
      fs.writeFileSync(artifactOut, JSON.stringify(artifact, null, 2));
      console.log(`\nArtifact written to: ${artifactOut}`);

      const registryPath = "evidence/artifacts-meridian/registry.json";
      const registry = loadRegistry(registryPath);
      const entry = getOrCreateEntry(registry, artifact);
      saveRegistry(registryPath, registry);
      console.log(`Registered as "${entry.approvalState}" in ${registryPath} (fingerprint ${entry.fingerprint}).`);
      console.log(`Run \`npm run approve -- --artifact ${artifactOut} --registry ${registryPath}\` once reviewed.`);
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
