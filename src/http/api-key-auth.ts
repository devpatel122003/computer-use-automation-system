import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { DEFAULT_OPERATOR_CONFIG_PATH, loadOperatorRegistry, type OperatorConfigEntry } from "./operator-registry.js";

/**
 * API-key auth for the two HTTP surfaces that expose real capability state or can trigger a
 * real action (capability API, dashboard). Deliberately not JWT/OAuth: there's exactly one
 * caller CLASS per surface (an agent invoking capabilities; an operator viewing the ops
 * dashboard), not a full multi-user identity system with roles/sessions -- see REPORT.md
 * "Safety" for why this stops short of a full identity provider. What DOES matter, and what
 * a single shared secret couldn't answer, is WHICH specific operator within that class
 * authenticated a given request -- so a presented credential now resolves to a named entry
 * in `config/operators.json` (`operator-registry.ts`) rather than a binary valid/invalid,
 * and that resolved id is attached to the request for evidence/audit logging downstream.
 */

declare global {
  namespace Express {
    interface Request {
      /** Set by requireApiKey/requireBasicAuth once auth succeeds -- the id of the
       *  config/operators.json entry whose credential matched. NOT the same concept as the
       *  active target's `fillParams` in src/chat-ui/server.ts (the target-system sign-on
       *  credential the chat UI injects into capability params) -- this is who
       *  authenticated to THIS system's own HTTP surface. */
      operatorId?: string;
    }
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // crypto.timingSafeEqual throws on length mismatch rather than returning false, and a
  // length-dependent early return would itself leak the secret's length via response
  // timing -- hash both to a fixed-length digest first so the comparison is constant-time
  // regardless of the candidate's length.
  const digestA = crypto.createHash("sha256").update(bufA).digest();
  const digestB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Fails closed and loud if no operator in the registry has a usable API key configured,
 * rather than silently accepting every request -- an unset env var should never be
 * indistinguishable from "auth intentionally disabled."
 */
export function requireApiKey(config: string | OperatorConfigEntry[] = DEFAULT_OPERATOR_CONFIG_PATH) {
  const operators = loadOperatorRegistry(config).filter((op): op is { id: string; apiKey: string } => !!op.apiKey);
  if (operators.length === 0) {
    throw new Error(
      "No operator in the registry has a usable API key -- every apiKeyEnvVar is unset. " +
        "This server refuses to start unauthenticated -- see config/operators.json and .env.example."
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = extractBearerToken(req.header("authorization")) ?? req.header("x-api-key") ?? null;
    const match = provided ? operators.find((op) => timingSafeEqual(provided, op.apiKey)) : undefined;
    if (!match) {
      res.status(401).json({ error: "Unauthorized. Provide a valid API key via 'Authorization: Bearer <key>' or 'X-API-Key'." });
      return;
    }
    req.operatorId = match.id;
    next();
  };
}

/**
 * HTTP Basic auth, for the one surface a human opens directly in a browser (the ops
 * dashboard) rather than a script/agent calling with a header it controls -- browsers
 * natively prompt for Basic credentials on a 401 + WWW-Authenticate, so this needs no
 * login form of its own. The username now matters (it's looked up against the registry,
 * not discarded) so a request can be attributed to a specific operator, not just "someone
 * who knew a shared password."
 *
 * Disclosed limitation, not engineered around: looking up by username with `===` before the
 * timing-safe password comparison is a theoretical username-enumeration timing signal (a
 * nonexistent username fails fast; an existing one runs a full compare). Accepted -- matches
 * this file's existing "not a full identity provider" posture, not worth the added
 * complexity here; see SECURITY.md.
 */
export function requireBasicAuth(config: string | OperatorConfigEntry[] = DEFAULT_OPERATOR_CONFIG_PATH) {
  const operators = loadOperatorRegistry(config).filter(
    (op): op is { id: string; dashboardUsername: string; dashboardPassword: string } => !!op.dashboardUsername && !!op.dashboardPassword
  );
  if (operators.length === 0) {
    throw new Error(
      "No operator in the registry has dashboard credentials configured -- see config/operators.json and .env.example."
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization");
    const match = header ? /^Basic (.+)$/.exec(header) : null;
    const decoded = match ? Buffer.from(match[1], "base64").toString("utf-8") : null;
    const sep = decoded?.indexOf(":") ?? -1;
    const username = sep >= 0 ? decoded!.slice(0, sep) : null;
    const password = sep >= 0 ? decoded!.slice(sep + 1) : null;

    const byUsername = username ? operators.find((op) => op.dashboardUsername === username) : undefined;
    if (!byUsername || !password || !timingSafeEqual(password, byUsername.dashboardPassword)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Capability Dashboard"');
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    req.operatorId = byUsername.id;
    next();
  };
}
