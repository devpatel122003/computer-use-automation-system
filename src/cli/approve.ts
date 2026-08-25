import fs from "node:fs";
import { CapabilityArtifactSchema } from "../artifact/schema.js";
import { computeConfidence, getOrCreateEntry, loadRegistry, saveRegistry, setApprovalState } from "../artifact/registry.js";
import { applyTenantOverride, TenantOverrideSchema } from "../artifact/tenant-override.js";
import { parseArgs } from "./args.js";

const DEFAULT_REGISTRY_PATH = "evidence/artifacts/registry.json";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "evidence/artifacts/open-sub-account.artifact.json";
  const registryPath = args.registry ?? DEFAULT_REGISTRY_PATH;
  const revoke = args.revoke === "true";

  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const baseArtifact = CapabilityArtifactSchema.parse(raw);

  // A tenant-overridden artifact (same flag as `replay --tenant-override`) has its own
  // content fingerprint and so its own draft/approved state, independent of the base
  // artifact's -- without this, there was no way to approve a tenant's variant at all,
  // since it only ever exists in-memory at replay/invoke time, never as a file on disk.
  const tenantOverridePath = args["tenant-override"];
  let artifact = baseArtifact;
  if (tenantOverridePath) {
    const overrideRaw = JSON.parse(fs.readFileSync(tenantOverridePath, "utf-8"));
    const override = TenantOverrideSchema.parse(overrideRaw);
    artifact = applyTenantOverride(baseArtifact, override);
    console.log(`Applying tenant override "${override.tenantId}" from ${tenantOverridePath}`);
  }

  const registry = loadRegistry(registryPath);
  const entry = getOrCreateEntry(registry, artifact);
  const confidence = computeConfidence(entry);

  console.log(`Artifact: ${artifact.name} v${artifact.version} (${entry.fingerprint})`);
  console.log(`Current approval state: ${entry.approvalState}`);
  console.log(`Confidence: ${confidence.label} (${confidence.successCount}/${confidence.totalRuns} clean runs)`);

  if (revoke) {
    setApprovalState(entry, "draft");
    saveRegistry(registryPath, registry);
    console.log("\nApproval revoked -- this artifact content is back in draft state.");
    return;
  }

  if (confidence.totalRuns === 0) {
    console.log(
      "\nWarning: this exact artifact content has never been replayed. Approving it now means its " +
        "first unattended production run would also be its first real test. Consider running " +
        "`npm run replay` against it a few times first."
    );
  }

  setApprovalState(entry, "approved");
  saveRegistry(registryPath, registry);
  console.log("\nApproved. --allow-risky will now be honored for this exact artifact content on replay.");
}

main();
