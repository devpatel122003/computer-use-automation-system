import "dotenv/config";
import {
  CLOSE_SUB_ACCOUNT_KNOWN_OUTCOMES,
  CLOSE_SUB_ACCOUNT_PARAM_MAPPINGS,
  CLOSE_SUB_ACCOUNT_SUCCESS_CHECKPOINT,
  annotateCloseSubAccountCheckpoints,
} from "./capabilities/close-sub-account.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

/**
 * The fifth real capability: closing an existing sub-account. Needs a member who already
 * HAS a sub-account to close -- deliberately created via a separate `open-sub-account`
 * replay before this script runs (see README), not as part of THIS discovery's own goal, so
 * the recorded artifact only ever contains "close" steps, not "open, then close" conflated
 * into one capability.
 */

const DEFAULT_USERNAME = "demo_operator";
const DEFAULT_PASSWORD = "demo_password";
const DEFAULT_MEMBER_ID = "10002";

function buildDefaultGoal(username: string, password: string, memberId: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}", look up member ${memberId}, ` +
    "close their existing sub-account, and reach the confirmation screen."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const memberId = args["member-id"] ?? DEFAULT_MEMBER_ID;
  const goal = args.goal ?? buildDefaultGoal(username, password, memberId);
  const startUrl = args["start-url"] ?? "http://localhost:4000/login";
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts/close-sub-account.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "close-sub-account",
    capabilityId: "close-sub-account",
    name: "Close Sub-Account",
    description: "Signs on, looks up a member, and closes one of their existing sub-accounts, then confirms the result.",
    version: "1.0.0",
    appId: "mock-bank",
    baseUrlPattern: "http://localhost:4000",
    paramMappings: CLOSE_SUB_ACCOUNT_PARAM_MAPPINGS,
    successCheckpoint: CLOSE_SUB_ACCOUNT_SUCCESS_CHECKPOINT,
    knownOutcomes: CLOSE_SUB_ACCOUNT_KNOWN_OUTCOMES,
    annotate: annotateCloseSubAccountCheckpoints,
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
