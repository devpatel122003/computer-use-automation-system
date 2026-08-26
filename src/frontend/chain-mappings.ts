/**
 * The entire allowed "chain" surface for multi-step chat requests (e.g. "create a new
 * member named Dave, then open a savings account for them with $100"), hand-authored and
 * reviewable in one glance -- deliberately NOT derived from automatically matching output
 * field names against input param names, since the real names don't match:
 * `create-member`'s output is `newMemberId`, but every consumer capability's input is
 * `memberId`. Verified against the real artifacts in `evidence/artifacts/*.artifact.json`:
 * `create-member` is the only capability with any live consumer today (`open-sub-account`'s
 * own output, `confirmationNumber`, has none) -- this table is deliberately that short, not
 * a general graph, matching the scope of what's actually demoable today.
 */

export interface ChainMapping {
  fromCapabilityId: string;
  /** Real output field name on the FROM capability's own outputSchema. */
  fromField: string;
  toCapabilityId: string;
  /** Real input param name on the TO capability's own inputParams. */
  toField: string;
}

export const CHAIN_MAPPINGS: ChainMapping[] = [
  { fromCapabilityId: "create-member", fromField: "newMemberId", toCapabilityId: "open-sub-account", toField: "memberId" },
  { fromCapabilityId: "create-member", fromField: "newMemberId", toCapabilityId: "transfer-funds", toField: "memberId" },
  { fromCapabilityId: "create-member", fromField: "newMemberId", toCapabilityId: "check-balance", toField: "memberId" },
  { fromCapabilityId: "create-member", fromField: "newMemberId", toCapabilityId: "close-sub-account", toField: "memberId" },
];

export function findChainMapping(fromCapabilityId: string, toCapabilityId: string): ChainMapping | undefined {
  return CHAIN_MAPPINGS.find((m) => m.fromCapabilityId === fromCapabilityId && m.toCapabilityId === toCapabilityId);
}
