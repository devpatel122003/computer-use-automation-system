import "dotenv/config";
import {
  OPEN_SUB_ACCOUNT_KNOWN_OUTCOMES,
  OPEN_SUB_ACCOUNT_PARAM_MAPPINGS,
  OPEN_SUB_ACCOUNT_SUCCESS_CHECKPOINT,
  annotateOpenSubAccountCheckpoints,
} from "./capabilities/open-sub-account.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

const DEFAULT_USERNAME = "demo_operator";
const DEFAULT_PASSWORD = "demo_password";

function buildDefaultGoal(username: string, password: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}", look up member 10001, ` +
    "explicitly select Savings as the account type, open a new sub-account with an initial " +
    "deposit of $100, and once you reach the confirmation screen, extract and report the " +
    "confirmation number."
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

  await runDiscoveryCli({
    id: "open-sub-account",
    capabilityId: "open-sub-account",
    name: "Open Sub-Account",
    description:
      "Signs on, looks up a member by ID, opens a new sub-account with a specified type and initial deposit, and confirms the result.",
    version: "1.0.0",
    appId: "mock-bank",
    baseUrlPattern: "http://localhost:4000",
    paramMappings: OPEN_SUB_ACCOUNT_PARAM_MAPPINGS,
    successCheckpoint: OPEN_SUB_ACCOUNT_SUCCESS_CHECKPOINT,
    knownOutcomes: OPEN_SUB_ACCOUNT_KNOWN_OUTCOMES,
    annotate: annotateOpenSubAccountCheckpoints,
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
