import "dotenv/config";
import {
  MERIDIAN_OPEN_SHARE_KNOWN_OUTCOMES,
  MERIDIAN_OPEN_SHARE_PARAM_MAPPINGS,
  MERIDIAN_OPEN_SHARE_SUCCESS_CHECKPOINT,
  annotateMeridianOpenShareCheckpoints,
} from "./capabilities/meridian-open-share.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

const DEFAULT_USERNAME = "teller1";
const DEFAULT_PASSWORD = "password";
const DEFAULT_BRANCH = "MAIN-001";
const DEFAULT_MEMBER_ID = "100987";
const DEFAULT_SHARE_TYPE = "MMKT";
const DEFAULT_DEPOSIT = "25.00";
const DEFAULT_START_URL = "https://web-sample.interface-hiring.com/signon";

// The dropdown's real option values (confirmed live) don't carry their own visible text --
// discovery has to be told the exact label to select, since MERIDIAN has no <label> at all
// (see meridian-open-share.ts's own doc comment on dom-scan.ts's accessible-name fallback).
const SHARE_TYPE_LABELS: Record<string, string> = {
  S0001: "S0001 - Regular Shares",
  S0070: "S0070 - Share Draft (Checking)",
  MMKT: "MMKT - Money Market",
  CERT: "CERT - Certificate",
};

function buildDefaultGoal(username: string, password: string, branch: string, memberId: string, shareType: string, deposit: string): string {
  const shareTypeLabel = SHARE_TYPE_LABELS[shareType];
  if (!shareTypeLabel) {
    throw new Error(`Unknown share type "${shareType}" -- expected one of: ${Object.keys(SHARE_TYPE_LABELS).join(", ")}`);
  }
  return (
    `Sign on as operator "${username}" with password "${password}" at branch "${branch}", then from the ` +
    'Main Menu choose "Open New Share". Search for member number ' +
    `"${memberId}" (leave "Search by" set to Member Number) and select that member from the results. ` +
    `On the Open New Share form, select the option whose exact visible text is "${shareTypeLabel}" in ` +
    `the "Share Type:" dropdown, enter "${deposit}" ` +
    'in the "Initial Deposit:" field, and click Continue. On the review page, confirm the details shown ' +
    'match (member, share type, deposit amount) and click "Open Share" to post it. Once you reach the ' +
    'confirmation page, extract the Confirmation number (store as "confirmationNumber") and the New Share ' +
    'ID (store as "newShareId").'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const memberId = args["member-id"] ?? DEFAULT_MEMBER_ID;
  const shareType = args["share-type"] ?? DEFAULT_SHARE_TYPE;
  const deposit = args.deposit ?? DEFAULT_DEPOSIT;
  const goal = args.goal ?? buildDefaultGoal(username, password, branch, memberId, shareType, deposit);
  const startUrl = args["start-url"] ?? DEFAULT_START_URL;
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts-meridian/meridian-open-share.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "meridian-open-share",
    capabilityId: "meridian-open-share",
    name: "MERIDIAN: Open New Share",
    description: "Signs on to MERIDIAN CORE, opens a new share for a member, and reports the confirmation number and new share id.",
    version: "1.0.0",
    appId: "meridian-core",
    baseUrlPattern: "https://web-sample.interface-hiring.com",
    paramMappings: MERIDIAN_OPEN_SHARE_PARAM_MAPPINGS,
    successCheckpoint: MERIDIAN_OPEN_SHARE_SUCCESS_CHECKPOINT,
    knownOutcomes: MERIDIAN_OPEN_SHARE_KNOWN_OUTCOMES,
    annotate: annotateMeridianOpenShareCheckpoints,
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
