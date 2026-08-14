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

// Below this length, scrubbing every substring match does more harm than good -- e.g. a
// short/weak secret could coincidentally match part of an unrelated member ID or amount
// elsewhere in the same log line, over-redacting legitimate business data. Key-based
// redaction (above) still fully masks a short secret when it's stored under a flagged key;
// this threshold only limits the blind whole-log substring scan.
const MIN_SCRUBBABLE_VALUE_LENGTH = 6;

function scrubKnownValues(value: string, sensitiveValues: Set<string>): string {
  let out = value;
  for (const secret of sensitiveValues) {
    if (secret && secret.length >= MIN_SCRUBBABLE_VALUE_LENGTH) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

/** Deep-redacts a value: masks fields whose key is known-sensitive (whatever type or shape
 *  that field's value has -- a number, a nested object, an array), scrubs any occurrence of
 *  a known sensitive value regardless of which field it appears under, and scrubs SSN/card-
 *  shaped strings anywhere else as defense in depth. */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const sensitiveKeys = options.sensitiveKeys ?? new Set<string>();
  const sensitiveValues = options.sensitiveValues ?? new Set<string>();

  // Checked BEFORE the type-based branches below: a key flagged sensitive must mask its
  // whole value no matter what shape that value is. A numeric PIN/SSN, or an object like
  // `{ password: { value: "hunter2" } }`, previously fell through untouched because this
  // check used to live only inside the `typeof value === "string"` branch.
  if (options.keyHint && (sensitiveKeys.has(options.keyHint) || SENSITIVE_KEY_PATTERN.test(options.keyHint))) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return scrubString(scrubKnownValues(value, sensitiveValues));
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, { sensitiveKeys, sensitiveValues }));
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
