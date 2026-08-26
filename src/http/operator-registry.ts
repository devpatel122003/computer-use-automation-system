import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Replaces the single-shared-secret model `requireApiKey`/`requireBasicAuth` used to have
 * (one env var, one expected value, binary valid/invalid) with a small named-operator
 * registry: a presented credential now resolves to a SPECIFIC operator id, which flows into
 * the evidence log and the compliance audit report -- closing the exact gap `SECURITY.md`
 * and `audit-report.ts`'s own generated text already disclosed ("does not currently record
 * *which human*..."). Same loading convention as `src/guardrails/allowlist.ts`: a committed
 * JSON file pointing at env var NAMES, never containing a secret value itself.
 *
 * Naming note: this "operator" is a DIFFERENT concept from `CHAT_UI_OPERATOR_USERNAME`/
 * `PASSWORD` (the mock-bank sign-on credential the chat UI injects into capability params --
 * see chat-ui/server.ts). This one is "who authenticated to THIS system's own HTTP surfaces
 * (the capability API, the dashboard)." The two are unrelated; don't conflate them.
 */

export interface OperatorConfigEntry {
  /** Stable identity -- becomes `req.operatorId`, the evidence log's `operatorId` field, and
   *  the compliance audit report's "Operator" line. */
  id: string;
  /** Env var holding this operator's capability-API bearer/X-API-Key credential, if any. */
  apiKeyEnvVar?: string;
  /** Dashboard Basic-auth username -- not secret, just an identifier. */
  dashboardUsername?: string;
  /** Env var holding this operator's dashboard Basic-auth password, if any. */
  dashboardPasswordEnvVar?: string;
}

export interface ResolvedOperator {
  id: string;
  apiKey?: string;
  dashboardUsername?: string;
  dashboardPassword?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OPERATOR_CONFIG_PATH = path.join(__dirname, "..", "..", "config", "operators.json");

/**
 * Resolves each entry's env-var pointers to actual values. An operator whose relevant env
 * var is unset simply doesn't get that credential (`undefined`, not an empty string) --
 * this is how an operator with no usable credential gets silently excluded from matching,
 * rather than an unset env var coincidentally matching an empty presented value.
 */
export function loadOperatorRegistry(config: string | OperatorConfigEntry[] = DEFAULT_OPERATOR_CONFIG_PATH): ResolvedOperator[] {
  const entries: OperatorConfigEntry[] = typeof config === "string" ? (JSON.parse(fs.readFileSync(config, "utf-8")) as OperatorConfigEntry[]) : config;

  return entries.map((entry) => ({
    id: entry.id,
    apiKey: entry.apiKeyEnvVar ? process.env[entry.apiKeyEnvVar] : undefined,
    dashboardUsername: entry.dashboardUsername,
    dashboardPassword: entry.dashboardPasswordEnvVar ? process.env[entry.dashboardPasswordEnvVar] : undefined,
  }));
}
