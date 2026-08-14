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

/** Finds an allowlist rule matching a pathname regardless of method. Used for verifying
 *  where an action landed: a server can respond to a POST by re-rendering the same page
 *  in place rather than redirecting (e.g. a validation error re-shown on the submit URL),
 *  so "the browser is currently at this pathname" doesn't imply "via a GET" the way a
 *  pre-flight navigation check can assume. */
export function matchRouteAnyMethod(config: AllowlistConfig, pathname: string): RouteMatch | null {
  for (const rule of config.routes) {
    if (patternToRegex(rule.pattern).test(pathname)) {
      return { rule };
    }
  }
  return null;
}

/**
 * Origin-based comparison, not a string prefix check. `String.startsWith` was the previous
 * implementation and is a real bypass: "http://localhost:40000/login" and
 * "http://localhost:4000.evil.example.com/login" both *start with* the allowed
 * "http://localhost:4000", and "http://localhost:4000@evil.com/login" parses (per the URL
 * spec) as userinfo "localhost:4000" on host "evil.com" -- a link with that href would pass
 * a prefix check and then actually navigate off-origin.
 */
export function isBaseUrlAllowed(config: AllowlistConfig, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  // Belt-and-suspenders on top of the origin check below: a URL with credentials embedded
  // is never something this system should be navigating to or authorizing.
  if (target.username || target.password) return false;

  return config.allowedBaseUrls.some((base) => {
    let baseUrl: URL;
    try {
      baseUrl = new URL(base);
    } catch {
      return false;
    }
    if (target.origin !== baseUrl.origin) return false;

    // If the allowed base also specifies a path prefix, require a full-segment match --
    // "/app" must not also allow "/app-danger".
    const basePath = baseUrl.pathname === "/" ? "" : baseUrl.pathname.replace(/\/$/, "");
    if (!basePath) return true;
    return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  });
}
