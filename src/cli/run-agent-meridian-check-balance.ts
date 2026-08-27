import "dotenv/config";
import {
  MERIDIAN_CHECK_BALANCE_KNOWN_OUTCOMES,
  MERIDIAN_CHECK_BALANCE_PARAM_MAPPINGS,
  MERIDIAN_CHECK_BALANCE_SUCCESS_CHECKPOINT,
  annotateMeridianCheckBalanceCheckpoints,
} from "./capabilities/meridian-check-balance.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

/**
 * The Adaptation Project's first capability against the real, live MERIDIAN CORE target
 * (https://web-sample.interface-hiring.com) -- read-only, minimum-bar #1 from the brief.
 * Only the goal/start-url/appId and the domain config file (imported above) differ from
 * run-agent-check-balance.ts, per the adaptation plan's own "config + new recordings, not
 * a rewrite" framing.
 */

const DEFAULT_USERNAME = "teller1";
const DEFAULT_PASSWORD = "password";
const DEFAULT_BRANCH = "MAIN-001";
const DEFAULT_START_URL = "https://web-sample.interface-hiring.com/signon";

function buildDefaultGoal(username: string, password: string, branch: string): string {
  return (
    `Sign on as operator "${username}" with password "${password}" at branch "${branch}", then from the ` +
    'Main Menu choose Member Inquiry / Selection, search for member number "100234" (leave "Search by" set ' +
    'to Member Number), select that member from the results, and once you reach the Member Record page: ' +
    'extract the member\'s Name (store as "memberName"); then, in the SHARES / BALANCES table, extract the ' +
    'Balance shown in the very first (topmost) row -- store as "primaryShareBalance" -- and the Status shown ' +
    'in that same first row -- store as "primaryShareStatus". The first row is always that member\'s Regular ' +
    "Shares account. Do not extract any other row."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const goal = args.goal ?? buildDefaultGoal(username, password, branch);
  const startUrl = args["start-url"] ?? DEFAULT_START_URL;
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts-meridian/meridian-check-balance.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "meridian-check-balance",
    capabilityId: "meridian-check-balance",
    name: "MERIDIAN: Check Balance",
    description: "Signs on to MERIDIAN CORE, looks up a member by number, and reports every share's current balance and status.",
    version: "1.0.0",
    appId: "meridian-core",
    baseUrlPattern: "https://web-sample.interface-hiring.com",
    paramMappings: MERIDIAN_CHECK_BALANCE_PARAM_MAPPINGS,
    successCheckpoint: MERIDIAN_CHECK_BALANCE_SUCCESS_CHECKPOINT,
    knownOutcomes: MERIDIAN_CHECK_BALANCE_KNOWN_OUTCOMES,
    annotate: annotateMeridianCheckBalanceCheckpoints,
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
