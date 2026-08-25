import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * API-key auth for the two HTTP surfaces that expose real capability state or can trigger a
 * real action (capability API, dashboard). Deliberately not JWT/OAuth: there's exactly one
 * caller class per surface (an agent invoking capabilities; an operator viewing the ops
 * dashboard), not a multi-user identity system, so a single shared secret checked with a
 * timing-safe comparison is the right amount of mechanism -- see REPORT.md "Safety" for why
 * this stops short of a full identity provider.
 */

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
 * Fails closed and loud if the expected key isn't configured, rather than silently
 * accepting every request -- an unset env var should never be indistinguishable from
 * "auth intentionally disabled."
 */
export function requireApiKey(envVarName: string) {
  const expectedKey = process.env[envVarName];
  if (!expectedKey) {
    throw new Error(
      `${envVarName} is not set. This server refuses to start unauthenticated -- set ${envVarName} in your .env (see .env.example).`
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = extractBearerToken(req.header("authorization")) ?? req.header("x-api-key") ?? null;
    if (!provided || !timingSafeEqual(provided, expectedKey)) {
      res.status(401).json({ error: "Unauthorized. Provide a valid API key via 'Authorization: Bearer <key>' or 'X-API-Key'." });
      return;
    }
    next();
  };
}

/**
 * HTTP Basic auth, for the one surface a human opens directly in a browser (the ops
 * dashboard) rather than a script/agent calling with a header it controls -- browsers
 * natively prompt for Basic credentials on a 401 + WWW-Authenticate, so this needs no
 * login form of its own. Username is fixed ("operator"); only the password half is a real
 * secret, checked with the same timing-safe comparison as the API-key path.
 */
export function requireBasicAuth(envVarName: string) {
  const expectedPassword = process.env[envVarName];
  if (!expectedPassword) {
    throw new Error(
      `${envVarName} is not set. This server refuses to start unauthenticated -- set ${envVarName} in your .env (see .env.example).`
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization");
    const match = header ? /^Basic (.+)$/.exec(header) : null;
    const decoded = match ? Buffer.from(match[1], "base64").toString("utf-8") : null;
    const providedPassword = decoded?.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : null;

    if (!providedPassword || !timingSafeEqual(providedPassword, expectedPassword)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Capability Dashboard"');
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    next();
  };
}
