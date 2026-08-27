import "dotenv/config";
import {
  CREATE_MEMBER_KNOWN_OUTCOMES,
  CREATE_MEMBER_PARAM_MAPPINGS,
  CREATE_MEMBER_SUCCESS_CHECKPOINT,
  annotateCreateMemberCheckpoints,
} from "./capabilities/create-member.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

/**
 * The second real capability this system records, not a variation on the first: enrolling
 * a brand new member, rather than acting on one that already exists.
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

  await runDiscoveryCli({
    id: "create-member",
    capabilityId: "create-member",
    name: "Create Member",
    description: "Signs on and enrolls a brand new member with an initial checking and savings balance, then confirms the result.",
    version: "1.0.0",
    appId: "mock-bank",
    baseUrlPattern: "http://localhost:4000",
    paramMappings: CREATE_MEMBER_PARAM_MAPPINGS,
    successCheckpoint: CREATE_MEMBER_SUCCESS_CHECKPOINT,
    knownOutcomes: CREATE_MEMBER_KNOWN_OUTCOMES,
    annotate: annotateCreateMemberCheckpoints,
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
