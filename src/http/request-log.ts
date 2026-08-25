import type { NextFunction, Request, Response } from "express";

/**
 * One structured JSON line per request to stdout -- container-friendly (no log file to
 * mount/rotate) and directly parseable by whatever log aggregator sits in front of it.
 * Deliberately logs shape, not content: method/path/status/duration, never headers or
 * bodies, so it can't become a second, unredacted channel for the credentials this system
 * already takes care to redact everywhere else (see src/guardrails/redaction.ts).
 */
export function requestLog(serviceName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      console.log(
        JSON.stringify({
          service: serviceName,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          timestamp: new Date().toISOString(),
        })
      );
    });
    next();
  };
}
