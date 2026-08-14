import type { Action, Surface } from "../surface/types.js";
import { isBaseUrlAllowed, loadAllowlist, matchRoute, type AllowlistConfig, type RiskLevel } from "./allowlist.js";

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

  async authorize(surface: Surface, action: Action): Promise<AuthorizationResult> {
    if (action.type === "type" || action.type === "select_option" || action.type === "extract" || action.type === "wait") {
      return { allowed: true, risk: "safe" };
    }

    const predicted = await surface.predictNavigation(action);
    if (!predicted) {
      // No navigation implied (e.g. a click with no enclosing form/link) -- treat conservatively as safe,
      // since it cannot change which route/method is in play.
      return { allowed: true, risk: "safe" };
    }

    if (!isBaseUrlAllowed(this.config, predicted.url)) {
      return {
        allowed: false,
        risk: "risky",
        reason: `Target URL ${predicted.url} is outside the allowed base URLs.`,
      };
    }

    const pathname = new URL(predicted.url).pathname;
    const match = matchRoute(this.config, pathname, predicted.method);
    if (!match) {
      return {
        allowed: false,
        risk: "risky",
        route: pathname,
        method: predicted.method,
        reason: `${predicted.method} ${pathname} is not in the configured route allowlist.`,
      };
    }

    return { allowed: true, risk: match.rule.risk, route: pathname, method: predicted.method };
  }
}
