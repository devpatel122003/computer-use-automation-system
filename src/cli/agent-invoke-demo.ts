import "dotenv/config";
import { parseArgs } from "./args.js";

/**
 * Stands in for "the agent-facing product" side of the brief's Section 1 framing: discovers
 * capabilities by calling GET /capabilities, then invokes one by name with typed args via
 * POST /capabilities/:id/invoke -- exactly the §8 stretch-goal wording ("an AI agent could
 * discover and invoke by name with typed args -- and show one being invoked"). No LLM here;
 * this script plays the role of the caller, not the discovery agent.
 */

interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  approvalState: string;
  inputParams: Array<{ name: string; required: boolean; type: string }>;
}

/**
 * Explains a 422 "no confirmation given" decline in terms that actually match why it
 * happened. Found for real while re-running this demo against a freshly recorded artifact:
 * once a few replays (including an expected negative-control failure) had run, the artifact
 * was already `approved` but its confidence had dropped back to "low", and this script's
 * old hardcoded message ("this capability isn't approved yet") was simply wrong in that
 * case -- confusing to say out loud in a live demo where the audience just watched `npm run
 * approve` succeed a few steps earlier. `draft` and "approved but not enough of a track
 * record / drift-capped" are both real, distinct reasons the confidence circuit breaker
 * (execution-policy.ts) can decline the exact same way; this picks the one that matches.
 */
export function explainDeclinedRisky(approvalState: string): string {
  if (approvalState === "approved") {
    return (
      'This capability is already "approved," but the API still declined the risky step -- its ' +
      "confidence hasn't built up enough of a track record yet for unattended risky steps (or UI-drift " +
      "has capped it). Run `npm run drift-report` or check the dashboard for detail, then re-run this " +
      "once more clean replay history has accumulated."
    );
  }
  return (
    'This capability isn\'t "approved" yet, so the API declined the risky step exactly ' +
    "like the CLI would -- run `npm run approve -- --artifact <path>` first, then re-run this."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = args["api-base"] ?? "http://localhost:4700";
  const capabilityId = args.capability ?? "open-sub-account";
  const paramsJson =
    args.params ?? '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}';
  const allowRisky = args["allow-risky"] !== "false";
  const tenantId = args.tenant;

  if (!process.env.CAPABILITY_API_KEY) {
    throw new Error("CAPABILITY_API_KEY is not set. Export it or add it to a .env file (see .env.example) -- it must match the key the capability API was started with.");
  }
  const authHeaders = { Authorization: `Bearer ${process.env.CAPABILITY_API_KEY}` };

  console.log(`Discovering capabilities: GET ${apiBase}/capabilities`);
  const listRes = await fetch(`${apiBase}/capabilities`, { headers: authHeaders });
  if (!listRes.ok) throw new Error(`GET /capabilities failed: HTTP ${listRes.status}`);
  const capabilities = (await listRes.json()) as CatalogEntry[];

  console.log(`Found ${capabilities.length} capability(ies):`);
  for (const c of capabilities) {
    const paramList = c.inputParams.map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`).join(", ");
    console.log(`  - ${c.id} ("${c.name}" v${c.version}) [${c.approvalState}] -- (${paramList})`);
  }

  const target = capabilities.find((c) => c.id === capabilityId);
  if (!target) {
    throw new Error(`Capability "${capabilityId}" not found. Run \`npm run run-agent\` first to record it.`);
  }

  const tenantSuffix = tenantId ? ` for tenant "${tenantId}"` : "";
  console.log(`\nInvoking "${target.id}"${tenantSuffix} by name with typed args (allowRisky=${allowRisky}): POST ${apiBase}/capabilities/${target.id}/invoke`);
  const invokeRes = await fetch(`${apiBase}/capabilities/${target.id}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ params: JSON.parse(paramsJson), allowRisky, tenantId }),
  });
  const result = await invokeRes.json();
  console.log(`\nHTTP ${invokeRes.status}`);
  console.log(JSON.stringify(result, null, 2));

  if (invokeRes.status === 422 && result.observed?.includes("no confirmation given")) {
    console.log(`\n${explainDeclinedRisky(target.approvalState)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
