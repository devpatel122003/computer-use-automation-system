export interface SubAccount {
  id: string;
  memberId: string;
  accountType: "Savings" | "Checking" | "CD";
  initialDeposit: number;
  openedAt: string;
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

// Populated by resetData() below, called once at module load -- a single source of truth
// for "fresh state" instead of duplicating slightly-different init logic here and there.
// The initial assignment previously stored direct references into `seedMembers` (only
// resetData()'s clone was deep), so any in-place mutation of a served Member object before
// the first reset would have permanently corrupted the seed data for the process lifetime.
export let members: Map<string, Member>;
export let subAccounts: Map<string, SubAccount>;
let nextSubAccountSeq = 1;
// New members created via /members/new get IDs starting well above the seeded range
// (10001-99999) so a freshly created member can never collide with a seeded one.
let nextMemberSeq = 20001;

// Simulates a session expiring exactly once mid-flow (a real, transient condition), rather
// than a permanently-broken member -- consumed on first trigger, reset via resetData().
export let sessionTimeoutArmed = true;

export function consumeSessionTimeoutArm(): boolean {
  if (!sessionTimeoutArmed) return false;
  sessionTimeoutArmed = false;
  return true;
}

export function resetData(): void {
  members = new Map(seedMembers.map((m) => [m.id, structuredClone(m)]));
  subAccounts = new Map();
  nextSubAccountSeq = 1;
  nextMemberSeq = 20001;
  sessionTimeoutArmed = true;
}

resetData();

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
  return record;
}

export function findSubAccount(id: string): SubAccount | undefined {
  return subAccounts.get(id);
}

export function createMember(name: string, checkingBalance: number, savingsBalance: number): Member {
  const id = String(nextMemberSeq++);
  const record: Member = { id, name, checkingBalance, savingsBalance };
  members.set(id, record);
  return record;
}
