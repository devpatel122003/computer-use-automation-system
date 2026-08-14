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
});
