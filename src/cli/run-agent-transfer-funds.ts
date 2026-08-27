import "dotenv/config";
import {
  TRANSFER_FUNDS_KNOWN_OUTCOMES,
  TRANSFER_FUNDS_PARAM_MAPPINGS,
  TRANSFER_FUNDS_SUCCESS_CHECKPOINT,
  annotateTransferFundsCheckpoints,
} from "./capabilities/transfer-funds.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

/** The fourth real capability: moving funds between a member's own checking and savings
 *  balances. */

const DEFAULT_USERNAME = "demo_operator";
const DEFAULT_PASSWORD = "demo_password";

function buildDefaultGoal(username: string, password: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}", look up member 10001, ` +
    "and transfer $100 from their Checking account to their Savings account, then reach the " +
    "confirmation screen."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const goal = args.goal ?? buildDefaultGoal(username, password);
  const startUrl = args["start-url"] ?? "http://localhost:4000/login";
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts/transfer-funds.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "transfer-funds",
    capabilityId: "transfer-funds",
    name: "Transfer Funds",
    description: "Signs on, looks up a member, and moves funds between their own checking and savings balances, then confirms the result.",
    version: "1.0.0",
    appId: "mock-bank",
    baseUrlPattern: "http://localhost:4000",
    paramMappings: TRANSFER_FUNDS_PARAM_MAPPINGS,
    successCheckpoint: TRANSFER_FUNDS_SUCCESS_CHECKPOINT,
    knownOutcomes: TRANSFER_FUNDS_KNOWN_OUTCOMES,
    annotate: annotateTransferFundsCheckpoints,
    goal,
    startUrl,
    password,
    artifactOut,
    registryPath: "evidence/artifacts/registry.json",
    headed,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
