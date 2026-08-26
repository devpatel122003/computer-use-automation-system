import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { fingerprintArtifact } from "../artifact/registry.js";
import { loadMatchingDriftReports } from "../replay/drift-loader.js";
import { buildOverrideScaffold, stepsNeedingOverride } from "../replay/self-heal.js";
import { parseArgs } from "./args.js";

/**
 * Self-healing locator proposals: closes the loop between drift-report (this system
 * already tells you WHICH steps are drifting) and cross-tenant reuse (tenant-override.ts
 * already knows HOW to patch a locator) by auto-generating the override's shape for a
 * human to finish, rather than making them re-derive "which steps, which strategy" by hand
 * from a drift-report printout. Never writes a real, approvable `<tenantId>.json` directly
 * -- always a `.proposed.json`-suffixed sibling, so it can never be silently picked up by
 * `replay --tenant-override` or `approve` without a human first reviewing and renaming it.
 */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "evidence/artifacts/open-sub-account.artifact.json";
  const runsDir = args["runs-dir"] ?? "evidence/runs";
  const tenantId = args["tenant-id"];

  if (!tenantId) {
    console.error("Missing required --tenant-id <id> -- which tenant's replay runs should be scanned for drift?");
    process.exitCode = 1;
    return;
  }

  const artifact = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(artifactPath, "utf-8")));
  const vendorProductId = args["vendor-product-id"] ?? artifact.target.appId;
  const outPath = args.out ?? path.join("config", "tenant-overrides", `${tenantId}.proposed.json`);

  const fingerprint = fingerprintArtifact(artifact);
  const reports = loadMatchingDriftReports(artifact, fingerprint, runsDir, tenantId);
  const needingOverride = stepsNeedingOverride(reports);

  console.log(`Scanning drift for ${artifact.name} v${artifact.version} (${fingerprint}), tenant "${tenantId}", under ${runsDir}`);

  if (needingOverride.length === 0) {
    console.log("No drifting, overridable steps found for this tenant -- nothing to propose.");
    return;
  }

  const scaffold = buildOverrideScaffold(artifact, reports, tenantId, vendorProductId);

  console.log(`\nFound ${needingOverride.length} drifting step(s) needing an override:`);
  for (const step of needingOverride) {
    console.log(`  ${step.stepId} -- ${step.description} (expected: ${step.expectedStrategy}, drift: ${step.driftCount}/${step.totalObservations})`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(scaffold, null, 2));

  console.log(`\nWrote a draft override scaffold to ${outPath}.`);
  console.log(
    `Next: inspect tenant "${tenantId}"'s live page for each step above, fill in each "TODO" name with the ` +
      `current accessible name/text, save it as config/tenant-overrides/${tenantId}.json, then run:\n` +
      `  npm run approve -- --tenant-override config/tenant-overrides/${tenantId}.json`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
