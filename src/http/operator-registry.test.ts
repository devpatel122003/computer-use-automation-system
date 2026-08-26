import { afterEach, describe, expect, it } from "vitest";
import { loadOperatorRegistry, type OperatorConfigEntry } from "./operator-registry.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadOperatorRegistry", () => {
  it("resolves an entry's env-var pointers to their actual values", () => {
    process.env.TEST_ALICE_KEY = "alice-secret";
    const entries: OperatorConfigEntry[] = [{ id: "alice", apiKeyEnvVar: "TEST_ALICE_KEY" }];
    const resolved = loadOperatorRegistry(entries);
    expect(resolved).toEqual([{ id: "alice", apiKey: "alice-secret", dashboardUsername: undefined, dashboardPassword: undefined }]);
  });

  it("resolves apiKey to undefined, not an empty string, when the referenced env var is unset", () => {
    delete process.env.TEST_UNSET_KEY;
    const resolved = loadOperatorRegistry([{ id: "bob", apiKeyEnvVar: "TEST_UNSET_KEY" }]);
    expect(resolved[0]?.apiKey).toBeUndefined();
  });

  it("resolves dashboard username/password together", () => {
    process.env.TEST_DASH_PW = "hunter2";
    const resolved = loadOperatorRegistry([{ id: "alice", dashboardUsername: "alice", dashboardPasswordEnvVar: "TEST_DASH_PW" }]);
    expect(resolved[0]).toEqual({ id: "alice", apiKey: undefined, dashboardUsername: "alice", dashboardPassword: "hunter2" });
  });

  it("accepts a real config file path, not just an in-memory array", () => {
    const resolved = loadOperatorRegistry("./config/operators.json");
    expect(resolved.map((o) => o.id)).toEqual(["local-operator", "chat-ui-service"]);
  });

  it("resolves multiple distinct operators independently", () => {
    process.env.TEST_ALICE_KEY = "alice-secret";
    process.env.TEST_BOB_KEY = "bob-secret";
    const resolved = loadOperatorRegistry([
      { id: "alice", apiKeyEnvVar: "TEST_ALICE_KEY" },
      { id: "bob", apiKeyEnvVar: "TEST_BOB_KEY" },
    ]);
    expect(resolved.find((o) => o.id === "alice")?.apiKey).toBe("alice-secret");
    expect(resolved.find((o) => o.id === "bob")?.apiKey).toBe("bob-secret");
  });
});
