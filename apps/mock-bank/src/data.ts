import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SubAccount {
  id: string;
  memberId: string;
  accountType: "Savings" | "Checking" | "CD";
  initialDeposit: number;
  openedAt: string;
  /** Undefined/absent means still open. Closed sub-accounts stay on record (shown as
   *  "Closed" on the member page) rather than being deleted -- a real bank keeps closed
   *  accounts on file, it doesn't erase them. */
  closedAt?: string;
}

export interface Member {
  id: string;
  name: string;
  checkingBalance: number;
  savingsBalance: number;
  permissionRestricted?: boolean;
  simulateSlow?: boolean;
  /** Simulates the brief's own named "unexpected confirmation dialog" runtime condition
   *  (Section 1): opening a sub-account for this member renders an interstitial the
   *  recorded flow never accounted for, instead of going straight to confirmation --
   *  deliberately NOT modeled as a knownOutcome, so replay genuinely hard-fails at step-10's
   *  checkpoint with nothing to explain it, the same way a real unanticipated dialog would.
   *  Standing scenario for the replay-side escalation-resume demo (see
   *  src/cli/escalation-resume-replay-demo.ts): a human dismissing the interstitial on the
   *  live session is something automation cannot do on its own, and there's no way to
   *  detect-and-recover from it generically the way session-timeout is. */
  requiresInterstitialConfirmation?: boolean;
}

const seedMembers: Member[] = [
  { id: "10001", name: "Alice Johnson", checkingBalance: 4210.55, savingsBalance: 12500.0 },
  { id: "10002", name: "Bob Martinez", checkingBalance: 980.1, savingsBalance: 300.0 },
  { id: "99999", name: "Restricted Member", checkingBalance: 0, savingsBalance: 0, permissionRestricted: true },
  { id: "55555", name: "Slow Member", checkingBalance: 500, savingsBalance: 500, simulateSlow: true },
  { id: "90909", name: "Tempo Member", checkingBalance: 1500.0, savingsBalance: 2200.0 },
  { id: "77777", name: "Dormant-Flag Member", checkingBalance: 75.0, savingsBalance: 40.0, requiresInterstitialConfirmation: true },
];

/**
 * Real, file-based persistence -- previously this was pure in-memory state, reset to seed
 * data on every process restart, which is fine for a single demo session but means anything
 * created (a new member, a new sub-account) vanishes the moment mock-bank restarts. This
 * app now behaves like it has a real (if trivially simple) database: every mutation is
 * written to `apps/mock-bank/data/state.<tenantId>.json` immediately, and startup resumes
 * from that file if one exists, instead of always reseeding.
 *
 * One file per tenant (keyed by the same TENANT env var `tenants.ts` already reads), not
 * one shared file -- mock-bank (:4000) and the northgate-cu variant (:4100) are two
 * independent processes from the same code and must not silently corrupt each other's data
 * when both run at once, exactly as they do for the cross-tenant reuse demo.
 *
 * `resetData()` (used by `POST /__test__/reset`) is the deliberate escape hatch: it
 * explicitly reseeds *and* re-persists, so a demo can still return to a known state on
 * request -- persistence means "survives a restart," not "can never be reset."
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const TENANT_ID = process.env.TENANT ?? "mock-bank";
const STATE_FILE = path.join(DATA_DIR, `state.${TENANT_ID}.json`);

interface PersistedState {
  members: Member[];
  subAccounts: SubAccount[];
  nextSubAccountSeq: number;
  nextMemberSeq: number;
  sessionTimeoutArmed: boolean;
}

function seedState(): PersistedState {
  return {
    members: seedMembers.map((m) => structuredClone(m)),
    subAccounts: [],
    nextSubAccountSeq: 1,
    nextMemberSeq: 20001,
    sessionTimeoutArmed: true,
  };
}

function persist(): void {
  const state: PersistedState = {
    members: Array.from(members.values()),
    subAccounts: Array.from(subAccounts.values()),
    nextSubAccountSeq,
    nextMemberSeq,
    sessionTimeoutArmed,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadOrSeed(): PersistedState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PersistedState;
    } catch (err) {
      // A corrupt/partially-written file is a real possibility (e.g. the process was
      // killed mid-write) -- fall back to seed data rather than crash the whole app on
      // startup over it.
      console.error(`mock-bank: ${STATE_FILE} was unreadable (${err}); starting from seed data instead.`);
    }
  }
  return seedState();
}

function applyState(state: PersistedState): void {
  members = new Map(state.members.map((m) => [m.id, m]));
  subAccounts = new Map(state.subAccounts.map((s) => [s.id, s]));
  nextSubAccountSeq = state.nextSubAccountSeq;
  nextMemberSeq = state.nextMemberSeq;
  sessionTimeoutArmed = state.sessionTimeoutArmed;
}

export let members: Map<string, Member>;
export let subAccounts: Map<string, SubAccount>;
let nextSubAccountSeq: number;
// New members created via /members/new get IDs starting well above the seeded range
// (10001-99999) so a freshly created member can never collide with a seeded one.
let nextMemberSeq: number;

// Simulates a session expiring exactly once mid-flow (a real, transient condition), rather
// than a permanently-broken member -- consumed on first trigger, reset via resetData().
export let sessionTimeoutArmed: boolean;

export function consumeSessionTimeoutArm(): boolean {
  if (!sessionTimeoutArmed) return false;
  sessionTimeoutArmed = false;
  persist();
  return true;
}

export function resetData(): void {
  applyState(seedState());
  persist();
}

// Resume from disk if this tenant has real persisted state; otherwise seed fresh and write
// it out immediately, so the file exists from the first run rather than only after the
// first mutation.
applyState(loadOrSeed());
if (!fs.existsSync(STATE_FILE)) persist();

export function findMember(id: string): Member | undefined {
  return members.get(id.trim());
}

export function createSubAccount(memberId: string, accountType: SubAccount["accountType"], initialDeposit: number): SubAccount {
  const id = `SA-${String(nextSubAccountSeq++).padStart(5, "0")}`;
  const record: SubAccount = {
    id,
    memberId,
    accountType,
    initialDeposit,
    openedAt: new Date(2026, 0, 1).toISOString(),
  };
  subAccounts.set(id, record);
  persist();
  return record;
}

export function findSubAccount(id: string): SubAccount | undefined {
  return subAccounts.get(id);
}

/** The combined "does this member own this sub-account" lookup+ownership check that
 *  server.ts's close-sub-account routes (GET/POST .../close, GET .../closed) each repeated
 *  verbatim -- centralized here since all three need the exact same answer. */
export function findSubAccountForMember(memberId: string, subId: string): { member: Member; subAccount: SubAccount } | undefined {
  const member = findMember(memberId);
  const subAccount = findSubAccount(subId);
  if (!member || !subAccount || subAccount.memberId !== member.id) return undefined;
  return { member, subAccount };
}

export function createMember(name: string, checkingBalance: number, savingsBalance: number): Member {
  const id = String(nextMemberSeq++);
  const record: Member = { id, name, checkingBalance, savingsBalance };
  members.set(id, record);
  persist();
  return record;
}

export type AccountKind = "Checking" | "Savings";

export type TransferResult = { ok: true } | { ok: false; error: "insufficient_funds" | "invalid_transfer" };

/** Moves funds between a member's OWN checking and savings balances -- not a transfer
 *  between two different members, and not one of the member's named sub-accounts. Two
 *  distinct failure reasons, not one generic one: "insufficient funds" is a genuinely
 *  different business condition from "the request itself doesn't make sense" (a zero/
 *  negative amount, or the same account on both sides), the same reasoning open-sub-account
 *  and create-member already apply to their own validation errors. */
export function transferFunds(memberId: string, from: AccountKind, to: AccountKind, amount: number): TransferResult {
  const member = members.get(memberId);
  if (!member) return { ok: false, error: "invalid_transfer" };
  if (from === to || !(amount > 0)) return { ok: false, error: "invalid_transfer" };

  const fromBalance = from === "Checking" ? member.checkingBalance : member.savingsBalance;
  if (fromBalance < amount) return { ok: false, error: "insufficient_funds" };

  if (from === "Checking") member.checkingBalance -= amount;
  else member.savingsBalance -= amount;
  if (to === "Checking") member.checkingBalance += amount;
  else member.savingsBalance += amount;

  persist();
  return { ok: true };
}

/** The route calling this already 404s if the sub-account doesn't exist at all, so
 *  "already_closed" is the one realistically reachable business outcome here -- closing the
 *  same sub-account twice, a genuinely real thing an operator (or a replayed artifact run
 *  twice) can attempt. */
export function closeSubAccount(subId: string): { ok: true } | { ok: false; error: "already_closed" } {
  const sa = subAccounts.get(subId);
  if (!sa) return { ok: false, error: "already_closed" }; // treated the same: nothing left to close
  if (sa.closedAt) return { ok: false, error: "already_closed" };
  sa.closedAt = new Date(2026, 0, 1).toISOString();
  persist();
  return { ok: true };
}
