export interface Account {
  id: string;
  customerName: string;
  serviceAddress: string;
  balanceDue: number;
  meterReading: number;
  status: "ACTIVE" | "SUSPENDED";
}

/**
 * A deliberately DIFFERENT domain from mock-bank/MERIDIAN (utility billing, not banking) --
 * built as a genuinely independent "new bank's UI" stand-in to test the console's "Register
 * a new target" flow against a target this repo's discovery agent has never seen, not a
 * relabeled copy of an existing one. Field names, route shapes, and terminology are all
 * unrelated to the banking apps on purpose.
 */
const seedAccounts: Account[] = [
  { id: "ACC-1001", customerName: "Miguel Alvarez", serviceAddress: "12 Birchwood Ln", balanceDue: 85.4, meterReading: 4521, status: "ACTIVE" },
  { id: "ACC-1002", customerName: "Harper Douglas", serviceAddress: "88 Fenwick Ct", balanceDue: 0, meterReading: 9902, status: "ACTIVE" },
  { id: "ACC-9999", customerName: "Test Suspended Account", serviceAddress: "1 Nowhere Rd", balanceDue: 240, meterReading: 1000, status: "SUSPENDED" },
];

let accounts: Map<string, Account>;

function seedState(): Account[] {
  return seedAccounts.map((a) => structuredClone(a));
}

export function resetData(): void {
  accounts = new Map(seedState().map((a) => [a.id, a]));
}
resetData();

export function findAccount(id: string): Account | undefined {
  return accounts.get(id.toUpperCase());
}

export function recordMeterReading(id: string, newReading: number): void {
  const account = accounts.get(id.toUpperCase());
  if (account) account.meterReading = newReading;
}
