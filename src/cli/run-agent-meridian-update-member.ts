import "dotenv/config";
import {
  MERIDIAN_UPDATE_MEMBER_KNOWN_OUTCOMES,
  MERIDIAN_UPDATE_MEMBER_PARAM_MAPPINGS,
  MERIDIAN_UPDATE_MEMBER_SUCCESS_CHECKPOINT,
  annotateMeridianUpdateMemberCheckpoints,
} from "./capabilities/meridian-update-member.js";
import { parseArgs } from "./args.js";
import { runDiscoveryCli } from "./discovery-cli.js";

const DEFAULT_USERNAME = "teller1";
const DEFAULT_PASSWORD = "password";
const DEFAULT_BRANCH = "MAIN-001";
const DEFAULT_MEMBER_ID = "103001";
const DEFAULT_EMAIL = "member103001@example.com";
const DEFAULT_PHONE = "555-0142";
const DEFAULT_ADDRESS = "77 Harbor View Rd, Newport";
const DEFAULT_START_URL = "https://web-sample.interface-hiring.com/signon";

function buildDefaultGoal(
  username: string,
  password: string,
  branch: string,
  memberId: string,
  email: string,
  phone: string,
  address: string,
): string {
  return (
    `Sign on as operator "${username}" with password "${password}" at branch "${branch}", then from the ` +
    'Main Menu choose "Update Member Information". Search for member number ' +
    `"${memberId}" (leave "Search by" set to Member Number) and select that member from the results. ` +
    `On the Update form, clear the "E-mail:" field and type "${email}", clear the "Phone:" field and type ` +
    `"${phone}", clear the "Mailing Address:" field and type "${address}", then click "Save Changes". Once ` +
    'you reach the confirmation page, extract the confirmation message text shown under "CHANGES SAVED" ' +
    '(store as "confirmationMessage").'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username ?? DEFAULT_USERNAME;
  const password = args.password ?? DEFAULT_PASSWORD;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const memberId = args["member-id"] ?? DEFAULT_MEMBER_ID;
  const email = args.email ?? DEFAULT_EMAIL;
  const phone = args.phone ?? DEFAULT_PHONE;
  const address = args.address ?? DEFAULT_ADDRESS;
  const goal = args.goal ?? buildDefaultGoal(username, password, branch, memberId, email, phone, address);
  const startUrl = args["start-url"] ?? DEFAULT_START_URL;
  const artifactOut = args["artifact-out"] ?? "evidence/artifacts-meridian/meridian-update-member.artifact.json";
  const headed = args.headless !== "true";

  await runDiscoveryCli({
    id: "meridian-update-member",
    capabilityId: "meridian-update-member",
    name: "MERIDIAN: Update Member Information",
    description: "Signs on to MERIDIAN CORE and updates a member's e-mail, phone, and mailing address in a single direct save (no review step).",
    version: "1.0.0",
    appId: "meridian-core",
    baseUrlPattern: "https://web-sample.interface-hiring.com",
    paramMappings: MERIDIAN_UPDATE_MEMBER_PARAM_MAPPINGS,
    successCheckpoint: MERIDIAN_UPDATE_MEMBER_SUCCESS_CHECKPOINT,
    knownOutcomes: MERIDIAN_UPDATE_MEMBER_KNOWN_OUTCOMES,
    annotate: annotateMeridianUpdateMemberCheckpoints,
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
