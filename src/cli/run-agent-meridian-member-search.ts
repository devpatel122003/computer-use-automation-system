import "dotenv/config";
import {
  MERIDIAN_MEMBER_SEARCH_KNOWN_OUTCOMES,
  MERIDIAN_MEMBER_SEARCH_PARAM_MAPPINGS,
  MERIDIAN_MEMBER_SEARCH_SUCCESS_CHECKPOINT,
  annotateMeridianMemberSearchCheckpoints,
} from "./capabilities/meridian-member-search.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

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

  await runDiscoveryCli({
    id: "meridian-member-search",
    capabilityId: "meridian-member-search",
    name: "MERIDIAN: Member Search",
    description: "Signs on to MERIDIAN CORE and searches for a member by number or last name, reporting the first match.",
    version: "1.0.0",
    appId: "meridian-core",
    baseUrlPattern: "https://web-sample.interface-hiring.com",
    paramMappings: MERIDIAN_MEMBER_SEARCH_PARAM_MAPPINGS,
    successCheckpoint: MERIDIAN_MEMBER_SEARCH_SUCCESS_CHECKPOINT,
    knownOutcomes: MERIDIAN_MEMBER_SEARCH_KNOWN_OUTCOMES,
    annotate: annotateMeridianMemberSearchCheckpoints,
    goal,
    startUrl,
    password,
    artifactOut,
    registryPath: "evidence/artifacts-meridian/registry.json",
    headed,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
