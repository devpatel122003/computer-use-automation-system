import "dotenv/config";
import {
  MERIDIAN_PLACE_HOLD_KNOWN_OUTCOMES,
  MERIDIAN_PLACE_HOLD_PARAM_MAPPINGS,
  MERIDIAN_PLACE_HOLD_SUCCESS_CHECKPOINT,
  annotateMeridianPlaceHoldCheckpoints,
} from "./capabilities/meridian-place-hold.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

// Must be a supervisor -- MERIDIAN's own real authorization check returns 403
// "SUPERVISOR OVERRIDE REQUIRED" at the /hold/review step for a non-supervisor (e.g.
// teller1), which this capability's own known-outcomes table classifies as the business
// outcome `supervisor_override_required`, exercised for real at replay/demo time.
const DEFAULT_USERNAME = "super1";
const DEFAULT_PASSWORD = "password";
const DEFAULT_BRANCH = "MAIN-001";
const DEFAULT_MEMBER_ID = "103001";
const DEFAULT_SHARE_ID = "103001-S0001";
const DEFAULT_REASON_CODE = "FRAUD";
const DEFAULT_START_URL = "https://web-sample.interface-hiring.com/signon";

function buildDefaultGoal(
  username: string,
  password: string,
  branch: string,
  memberId: string,
  shareId: string,
  reasonCode: string,
): string {
  return (
    `Sign on as operator "${username}" with password "${password}" at branch "${branch}", then from the ` +
    'Main Menu choose "Place Account Hold". Search for member number ' +
    `"${memberId}" (leave "Search by" set to Member Number) and select that member from the results. ` +
    `On the Place Account Hold form, select the option whose value is exactly "${shareId}" in the "Share:" ` +
    `dropdown, select the option whose value is exactly "${reasonCode}" in the "Reason Code:" dropdown, ` +
    'leave "Notes:" blank, and click Continue. On the review page, confirm the details shown match (member, ' +
    'share, reason) and click "Apply Hold" to post it. Once you reach the confirmation page, extract the ' +
    'Confirmation number (store as "confirmationNumber").'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const memberId = args["member-id"] ?? DEFAULT_MEMBER_ID;
  const shareId = args["share-id"] ?? DEFAULT_SHARE_ID;
  const reasonCode = args["reason-code"] ?? DEFAULT_REASON_CODE;
  const goal = args.goal ?? buildDefaultGoal(username, password, branch, memberId, shareId, reasonCode);
  const startUrl = args["start-url"] ?? DEFAULT_START_URL;
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts-meridian/meridian-place-hold.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "meridian-place-hold",
    capabilityId: "meridian-place-hold",
    name: "MERIDIAN: Place Account Hold",
    description: "Signs on to MERIDIAN CORE as a supervisor and places an irreversible hold on a member's share, reporting the confirmation number.",
    version: "1.0.0",
    appId: "meridian-core",
    baseUrlPattern: "https://web-sample.interface-hiring.com",
    paramMappings: MERIDIAN_PLACE_HOLD_PARAM_MAPPINGS,
    successCheckpoint: MERIDIAN_PLACE_HOLD_SUCCESS_CHECKPOINT,
    knownOutcomes: MERIDIAN_PLACE_HOLD_KNOWN_OUTCOMES,
    annotate: annotateMeridianPlaceHoldCheckpoints,
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
