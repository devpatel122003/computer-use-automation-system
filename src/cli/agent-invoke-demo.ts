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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = args["api-base"] ?? "http://localhost:4700";
  const capabilityId = args.capability ?? "open-sub-account";
  const paramsJson =
    args.params ?? '{"username":"demo_operator","password":"demo_password","memberId":"10002","accountType":"Savings","initialDeposit":"100"}';
  const allowRisky = args["allow-risky"] !== "false";

  console.log(`Discovering capabilities: GET ${apiBase}/capabilities`);
  const listRes = await fetch(`${apiBase}/capabilities`);
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

  console.log(`\nInvoking "${target.id}" by name with typed args (allowRisky=${allowRisky}): POST ${apiBase}/capabilities/${target.id}/invoke`);
  const invokeRes = await fetch(`${apiBase}/capabilities/${target.id}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: JSON.parse(paramsJson), allowRisky }),
  });
  const result = await invokeRes.json();
  console.log(`\nHTTP ${invokeRes.status}`);
  console.log(JSON.stringify(result, null, 2));

  if (invokeRes.status === 422 && result.observed?.includes("no confirmation given")) {
    console.log(
      `\nThis capability isn't "approved" yet, so the API declined the risky step exactly ` +
        `like the CLI would -- run \`npm run approve -- --artifact <path>\` first, then re-run this.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
