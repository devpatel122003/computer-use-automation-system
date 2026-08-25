import fs from "node:fs";
import path from "node:path";
import { buildRunAuditEntry, renderAuditReportMarkdown, type RunAuditEntry } from "../evidence/audit-report.js";
import type { LogEvent } from "../evidence/logger.js";
import { parseArgs } from "./args.js";

function readRunLog(runDir: string): LogEvent[] {
  const logPath = path.join(runDir, "log.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

function readResultJson(runDir: string): unknown {
  for (const name of ["replay-result.json", "discovery-result.json"]) {
    const p = path.join(runDir, name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = args["runs-dir"] ?? "evidence/runs";
  const outPath = args.out;

  const runDirs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => fs.statSync(path.join(runsDir, d)).isDirectory()) : [];

  const entries: RunAuditEntry[] = runDirs
    .map((runId) => {
      const dir = path.join(runsDir, runId);
      return buildRunAuditEntry(runId, readRunLog(dir), readResultJson(dir), dir);
    })
    .filter((e): e is RunAuditEntry => e !== null);

  const report = renderAuditReportMarkdown(entries, new Date().toISOString());

  if (outPath) {
    fs.writeFileSync(outPath, report);
    console.log(`Compliance audit report written to ${outPath} (${entries.length} run(s)).`);
  } else {
    console.log(report);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
