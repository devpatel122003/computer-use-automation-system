import { describe, expect, it } from "vitest";
import { redact, scrubString } from "./redaction.js";

describe("scrubString", () => {
  it("masks SSN-shaped strings", () => {
    expect(scrubString("SSN on file: 123-45-6789.")).toBe("SSN on file: [REDACTED-SSN].");
  });

  it("masks card-shaped strings", () => {
    expect(scrubString("Card: 4111 1111 1111 1111")).toBe("Card: [REDACTED-NUMBER]");
  });

  it("leaves ordinary text untouched", () => {
    expect(scrubString("Sub-account opened successfully.")).toBe("Sub-account opened successfully.");
  });
});

describe("redact", () => {
  it("masks values whose key name looks sensitive", () => {
    const out = redact({ password: "hunter2", username: "alice" }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.username).toBe("alice");
  });

  it("masks a registered sensitive VALUE regardless of the key it appears under", () => {
    // This is the exact real bug found while producing evidence: a goal string embeds a
    // credential in a generically-named field ("goal"), which key-based redaction alone
    // would miss entirely.
    const out = redact(
      { goal: 'Sign on with password "demo_password" and proceed.' },
      { sensitiveValues: new Set(["demo_password"]) }
    ) as Record<string, unknown>;
    expect(out.goal).toBe('Sign on with password "[REDACTED]" and proceed.');
  });

  it("redacts recursively through nested objects and arrays", () => {
    const out = redact({
      detail: { action: { type: "type", text: "hunter2" } },
      history: [{ password: "hunter2" }],
    }) as any;
    expect(out.detail.action.text).toBe("hunter2"); // "text" key alone isn't sensitive by name
    expect(out.history[0].password).toBe("[REDACTED]");
  });

  it("combines key-based and value-based redaction with sensitiveValues supplied", () => {
    const out = redact(
      { action: { text: "hunter2" } },
      { sensitiveValues: new Set(["hunter2"]) }
    ) as any;
    expect(out.action.text).toBe("[REDACTED]");
  });

  it("masks a non-string value under a sensitive key (e.g. a numeric PIN or SSN)", () => {
    // Real gap: Gemini/JSON tool args can be numbers, and the sensitivity check used to
    // live only inside the string branch, so a numeric secret went to disk in the clear.
    const out = redact({ password: 12345, ssn: 123456789, verified: true }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.ssn).toBe("[REDACTED]");
    expect(out.verified).toBe(true);
  });

  it("masks an object nested directly under a sensitive key, not just its string leaves", () => {
    const out = redact({ password: { value: "hunter2", hint: "pet name" } }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
  });

  it("masks an array nested directly under a sensitive key", () => {
    const out = redact({ tokens: ["a", "b"] }) as Record<string, unknown>;
    expect(out.tokens).toBe("[REDACTED]");
  });

  it("does not blindly scrub a short sensitive value as a substring match elsewhere", () => {
    // A weak/short secret shouldn't nuke unrelated legitimate data that happens to contain
    // the same characters (e.g. a member ID). Key-based redaction still fully masks a short
    // secret stored under a flagged field name; this only limits the blind substring scan.
    const out = redact({ note: "member 10001 has 1 account" }, { sensitiveValues: new Set(["1"]) }) as Record<string, unknown>;
    expect(out.note).toBe("member 10001 has 1 account");
  });

  it("still scrubs a sufficiently long sensitive value found under an unrelated key", () => {
    const out = redact({ note: "the code was ABC123XYZ today" }, { sensitiveValues: new Set(["ABC123XYZ"]) }) as Record<
      string,
      unknown
    >;
    expect(out.note).toBe("the code was [REDACTED] today");
  });
});
