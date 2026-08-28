import "dotenv/config";
import {
  CHECK_BALANCE_KNOWN_OUTCOMES,
  CHECK_BALANCE_PARAM_MAPPINGS,
  CHECK_BALANCE_SUCCESS_CHECKPOINT,
  annotateCheckBalanceCheckpoints,
} from "./capabilities/check-balance.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

/**
 * The third real capability, and the first that's entirely read-only: look up a member and
 * report their current checking/savings balance. No new mock-bank route was needed for this
 * one -- both values are already shown on /members/:id -- so this discovery run only ever
 * touches GET routes already on the allowlist as "safe."
 */

const DEFAULT_USERNAME = "demo_operator";
const DEFAULT_PASSWORD = "demo_password";

function buildDefaultGoal(username: string, password: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}", look up member 10001, ` +
    "and extract and report their full name, current checking balance, current savings " +
    "balance, and sub-accounts summary (the one-line summary shown on the member page, or " +
    '"No sub-accounts on file." if they have none).'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const goal = args.goal ?? buildDefaultGoal(username, password);
  const startUrl = args["start-url"] ?? "http://localhost:4000/login";
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts/check-balance.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "check-balance",
    capabilityId: "check-balance",
    name: "Check Balance",
    description: "Signs on, looks up a member by ID, and reports their current checking and savings balance.",
    version: "1.0.0",
    appId: "mock-bank",
    baseUrlPattern: "http://localhost:4000",
    paramMappings: CHECK_BALANCE_PARAM_MAPPINGS,
    successCheckpoint: CHECK_BALANCE_SUCCESS_CHECKPOINT,
    knownOutcomes: CHECK_BALANCE_KNOWN_OUTCOMES,
    annotate: annotateCheckBalanceCheckpoints,
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
