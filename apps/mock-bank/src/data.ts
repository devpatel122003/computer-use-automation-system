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
}

const seedMembers: Member[] = [
  { id: "10001", name: "Alice Johnson", checkingBalance: 4210.55, savingsBalance: 12500.0 },
  { id: "10002", name: "Bob Martinez", checkingBalance: 980.1, savingsBalance: 300.0 },
  { id: "99999", name: "Restricted Member", checkingBalance: 0, savingsBalance: 0, permissionRestricted: true },
  { id: "55555", name: "Slow Member", checkingBalance: 500, savingsBalance: 500, simulateSlow: true },
  { id: "90909", name: "Tempo Member", checkingBalance: 1500.0, savingsBalance: 2200.0 },
];

export let members: Map<string, Member> = new Map(seedMembers.map((m) => [m.id, m]));
export let subAccounts: Map<string, SubAccount> = new Map();
let nextSubAccountSeq = 1;

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
  sessionTimeoutArmed = true;
}

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
