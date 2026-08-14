/**
 * Central redaction utility. Applied to everything written to /evidence logs and to
 * artifacts before serialization -- regulated financial data must never be persisted
 * in the clear (Section 3.4).
 */

const SENSITIVE_KEY_PATTERN = /password|secret|token|ssn|social_security|credit_?card|cvv|\bpin\b/i;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_LIKE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

export function scrubString(value: string): string {
  return value.replace(SSN_PATTERN, "[REDACTED-SSN]").replace(CARD_LIKE_PATTERN, "[REDACTED-NUMBER]");
}

export interface RedactOptions {
  /** Field names known to be sensitive (e.g. from an artifact's input_params), always masked outright. */
  sensitiveKeys?: Set<string>;
  /**
   * Known secret VALUES (e.g. a password actually typed during discovery). Needed because a
   * sensitive value can flow through a generically-named field (an action's "text"), where
   * key-name matching alone would miss it.
   */
  sensitiveValues?: Set<string>;
  keyHint?: string;
}

function scrubKnownValues(value: string, sensitiveValues: Set<string>): string {
  let out = value;
  for (const secret of sensitiveValues) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Deep-redacts a value: masks fields whose key is known-sensitive, scrubs any occurrence of a
 *  known sensitive value regardless of which field it appears under, and scrubs SSN/card-shaped
 *  strings anywhere else as defense in depth. */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const sensitiveKeys = options.sensitiveKeys ?? new Set<string>();
  const sensitiveValues = options.sensitiveValues ?? new Set<string>();

  if (typeof value === "string") {
    if (options.keyHint && (sensitiveKeys.has(options.keyHint) || SENSITIVE_KEY_PATTERN.test(options.keyHint))) {
      return "[REDACTED]";
    }
    return scrubString(scrubKnownValues(value, sensitiveValues));
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, options));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(val, { sensitiveKeys, sensitiveValues, keyHint: key });
    }
    return out;
  }

  return value;
}
