import { describe, expect, it } from "vitest";
import { CHAIN_MAPPINGS, findChainMapping } from "./chain-mappings.js";

describe("CHAIN_MAPPINGS", () => {
  // Locks scope deliberately: this table should only ever grow when a NEW capability
  // output/input pair is verified against the real artifacts, not silently expand into a
  // general N-step graph. If this test needs updating, that should be a conscious choice,
  // not an accident.
  it("contains exactly the four verified create-member -> consumer rows and nothing else", () => {
    expect(CHAIN_MAPPINGS).toHaveLength(4);
    expect(CHAIN_MAPPINGS.every((m) => m.fromCapabilityId === "create-member" && m.fromField === "newMemberId")).toBe(true);
    expect(CHAIN_MAPPINGS.map((m) => m.toCapabilityId).sort()).toEqual(["check-balance", "close-sub-account", "open-sub-account", "transfer-funds"]);
    expect(CHAIN_MAPPINGS.every((m) => m.toField === "memberId")).toBe(true);
  });
});

describe("findChainMapping", () => {
  it("finds the mapping for a known pair", () => {
    expect(findChainMapping("create-member", "open-sub-account")).toEqual({
      fromCapabilityId: "create-member",
      fromField: "newMemberId",
      toCapabilityId: "open-sub-account",
      toField: "memberId",
    });
  });

  it("returns undefined for an unmapped pair", () => {
    expect(findChainMapping("check-balance", "transfer-funds")).toBeUndefined();
    expect(findChainMapping("open-sub-account", "close-sub-account")).toBeUndefined();
  });
});
