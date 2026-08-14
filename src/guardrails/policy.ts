import type { Action, Surface } from "../surface/types.js";
import { isBaseUrlAllowed, loadAllowlist, matchRoute, matchRouteAnyMethod, type AllowlistConfig, type RiskLevel } from "./allowlist.js";

export interface AuthorizationResult {
  allowed: boolean;
  risk: RiskLevel;
  route?: string;
  method?: "GET" | "POST";
  reason?: string;
}

export class GuardrailsPolicy {
  private readonly config: AllowlistConfig;

  constructor(configPath?: string) {
    this.config = loadAllowlist(configPath);
  }

  private authorizeUrl(url: string, method: "GET" | "POST"): AuthorizationResult {
    if (!isBaseUrlAllowed(this.config, url)) {
      return { allowed: false, risk: "risky", reason: `Target URL ${url} is outside the allowed base URLs.` };
    }
    const pathname = new URL(url).pathname;
    const match = matchRoute(this.config, pathname, method);
    if (!match) {
      return {
        allowed: false,
        risk: "risky",
        route: pathname,
        method,
        reason: `${method} ${pathname} is not in the configured route allowlist.`,
      };
    }
    return { allowed: true, risk: match.rule.risk, route: pathname, method };
  }

  async authorize(surface: Surface, action: Action): Promise<AuthorizationResult> {
    if (action.type === "type" || action.type === "select_option" || action.type === "extract") {
      return { allowed: true, risk: "safe" };
    }

    const predicted = await surface.predictNavigation(action);

    if (predicted === undefined) {
      // The target element didn't resolve at all -- there's nothing to authorize or
      // block. `perform()` is about to fail on its own (e.g. this step's target only
      // exists on the happy-path variant of the page), and that failure flows through the
      // normal known-outcome detection, not the guardrail layer. Treating "the element
      // isn't even there" as a guardrail block would misfile a business outcome (like
      // permission-denied, where the link legitimately isn't rendered) as a security event.
      return { allowed: true, risk: "safe" };
    }

    if (predicted === null) {
      // Fail CLOSED, not open: a click on an element that DOES exist but whose destination
      // we can't predict (no enclosing form/anchor -- e.g. a JS-driven onclick/fetch write,
      // common outside this legacy mock app) is exactly the case the allowlist exists to
      // catch. Treating "unknown" as "safe" would let precisely the write actions a modern
      // surface tends to use bypass the gate entirely.
      return {
        allowed: false,
        risk: "risky",
        reason: "Could not determine this action's destination (no enclosing form/anchor); refusing to authorize an indeterminate navigation.",
      };
    }

    return this.authorizeUrl(predicted.url, predicted.method);
  }

  /** Re-checks the allowlist against where an action actually landed (after any server-side
   *  redirect, or a same-URL re-render), not just where it was predicted to go before
   *  executing. A redirect chain can land somewhere the pre-flight check never saw. Method-
   *  agnostic on purpose: a server can respond to a POST by re-rendering the same page in
   *  place (e.g. a validation error redisplayed at the submit URL) rather than redirecting,
   *  so "we're now at this pathname" doesn't imply "via a GET" -- the pre-flight `authorize()`
   *  call already checked the actual method before the action executed. */
  authorizeLandedUrl(url: string): AuthorizationResult {
    if (!isBaseUrlAllowed(this.config, url)) {
      return { allowed: false, risk: "risky", reason: `Landed URL ${url} is outside the allowed base URLs.` };
    }
    const pathname = new URL(url).pathname;
    const match = matchRouteAnyMethod(this.config, pathname);
    if (!match) {
      return { allowed: false, risk: "risky", route: pathname, reason: `Landed on ${pathname}, which is not in the configured route allowlist.` };
    }
    return { allowed: true, risk: match.rule.risk, route: pathname };
  }
}
