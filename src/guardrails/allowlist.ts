import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RiskLevel = "safe" | "risky";
export type HttpMethod = "GET" | "POST";

export interface RouteRule {
  pattern: string; // e.g. "/members/:id/sub-accounts"
  methods: HttpMethod[];
  risk: RiskLevel;
}

export interface AllowlistConfig {
  allowedBaseUrls: string[];
  routes: RouteRule[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "..", "config", "allowlist.json");

export function loadAllowlist(configPath: string = DEFAULT_CONFIG_PATH): AllowlistConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as AllowlistConfig;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${escaped}$`);
}

export interface RouteMatch {
  rule: RouteRule;
}

/** Finds the allowlist rule matching a pathname + method, if any. */
export function matchRoute(config: AllowlistConfig, pathname: string, method: HttpMethod): RouteMatch | null {
  for (const rule of config.routes) {
    if (patternToRegex(rule.pattern).test(pathname) && rule.methods.includes(method)) {
      return { rule };
    }
  }
  return null;
}

export function isBaseUrlAllowed(config: AllowlistConfig, url: string): boolean {
  return config.allowedBaseUrls.some((base) => url.startsWith(base));
}
