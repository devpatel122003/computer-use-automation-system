import type { ReplayResult } from "../replay/types.js";

/**
 * Maps the replay engine's own three-way result (REPORT.md "Determinism & error handling")
 * onto HTTP status codes for the capability-invocation API. `business_outcome` gets 200,
 * same as `success` -- it's the caller's answer, not an error, exactly like the replay CLI
 * exits 0 for it. Only a genuine `failure` (nothing in knownOutcomes explains the deviation)
 * gets a non-2xx, so a caller can `if (response.ok)` and still branch on `status` for the
 * business-outcome-vs-success distinction it actually needs.
 */
export function statusCodeFor(result: ReplayResult): number {
  switch (result.status) {
    case "success":
    case "business_outcome":
      return 200;
    case "failure":
      return 422;
  }
}
