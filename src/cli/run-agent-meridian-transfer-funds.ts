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
  MERIDIAN_TRANSFER_FUNDS_KNOWN_OUTCOMES,
  MERIDIAN_TRANSFER_FUNDS_PARAM_MAPPINGS,
  MERIDIAN_TRANSFER_FUNDS_SUCCESS_CHECKPOINT,
  annotateMeridianTransferFundsCheckpoints,
} from "./capabilities/meridian-transfer-funds.js";

/**
 * Minimum-bar #2 from the Adaptation Project brief: an irreversible write against the real,
 * live MERIDIAN CORE target. Mirrors run-agent-meridian-check-balance.ts's own structure.
 */

const DEFAULT_USERNAME = "teller1";
const DEFAULT_PASSWORD = "password";
const DEFAULT_BRANCH = "MAIN-001";
const DEFAULT_START_URL = "https://web-sample.interface-hiring.com/signon";
const DEFAULT_MEMBER_ID = "100987";
const DEFAULT_FROM_SHARE = "100987-S0001-13";
const DEFAULT_TO_SHARE = "100987-MMKT-11";
const DEFAULT_AMOUNT = "5.00";

function buildDefaultGoal(username: string, password: string, branch: string, memberId: string, fromShare: string, toShare: string, amount: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}" at branch "${branch}", then from the Main ` +
    `Menu choose Funds Transfer, search for member number "${memberId}" (leave "Search by" set to Member ` +
    `Number), select that member from the results, then on the member record page click "Funds Transfer" in ` +
    `the ACTIONS row. On the transfer form: set From Share to "${fromShare}", set To Share to "${toShare}", ` +
    `enter Amount "${amount}", enter Memo "Adaptation Project demo transfer", and click Continue. On the ` +
    'confirmation ("CONFIRM FUNDS TRANSFER") page, click Post Transfer. Once you reach "TRANSFER POSTED", ' +
    'extract the Confirmation number (store as "confirmationNumber").'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const memberId = args["member-id"] ?? DEFAULT_MEMBER_ID;
  const fromShare = args["from-share"] ?? DEFAULT_FROM_SHARE;
  const toShare = args["to-share"] ?? DEFAULT_TO_SHARE;
  const amount = args.amount ?? DEFAULT_AMOUNT;
  const goal = args.goal ?? buildDefaultGoal(username, password, branch, memberId, fromShare, toShare, amount);
  const startUrl = args["start-url"] ?? DEFAULT_START_URL;
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts-meridian/meridian-transfer-funds.artifact.json";
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
    const escalation = new EscalationController(surface.getPage(), logger, runId, "discovery", "meridian-transfer-funds");

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
        id: "meridian-transfer-funds",
        name: "MERIDIAN: Transfer Funds",
        description: "Signs on to MERIDIAN CORE, moves funds between a member's own shares (review -> post), and reports the confirmation number.",
        version: "1.0.0",
        appId: "meridian-core",
        baseUrlPattern: "https://web-sample.interface-hiring.com",
        paramMappings: MERIDIAN_TRANSFER_FUNDS_PARAM_MAPPINGS,
        successCheckpoint: MERIDIAN_TRANSFER_FUNDS_SUCCESS_CHECKPOINT,
        knownOutcomes: MERIDIAN_TRANSFER_FUNDS_KNOWN_OUTCOMES,
      });
      annotateMeridianTransferFundsCheckpoints(artifact);

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
