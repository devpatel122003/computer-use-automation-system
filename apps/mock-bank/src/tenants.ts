/**
 * Two tenants running the *same* vendor product (this app), configured/branded
 * differently -- a stand-in for the real "hundreds of tenants, ~20 apps each, many
 * sharing the same underlying vendor product" environment described in the brief (§1,
 * §3.7) and in interface.ai's own Integration Manager (25+ core banking systems, each
 * with many differently-branded tenant deployments). Routes, form field names/ids, and
 * business logic are identical across tenants -- only visible copy differs, which is
 * exactly the axis a real white-labeled deployment varies on. See
 * `src/artifact/tenant-override.ts` and REPORT.md "Heterogeneity & multi-tenant" for how
 * a single recorded artifact adapts to this without being re-recorded.
 */

export interface TenantLabels {
  tenantId: string;
  brandName: string;
  bannerText: string;
  operatorIdLabel: string;
  passwordLabel: string;
  signOnLabel: string;
  memberIdLabel: string;
  lookUpMemberLabel: string;
  openNewSubAccountLabel: string;
  accountTypeLabel: string;
  initialDepositLabel: string;
  submitLabel: string;
  sessionExpiredText: string;
  memberNotFoundText: string;
  accessDeniedText: string;
  minDepositErrorText: string;
  confirmationBannerText: string;
}

const TENANTS: Record<string, TenantLabels> = {
  "mock-bank": {
    tenantId: "mock-bank",
    brandName: "CU Core",
    bannerText: "",
    operatorIdLabel: "Operator ID",
    passwordLabel: "Password",
    signOnLabel: "Sign On",
    memberIdLabel: "Member ID",
    lookUpMemberLabel: "Look Up Member",
    openNewSubAccountLabel: "Open New Sub-Account",
    accountTypeLabel: "Account Type",
    initialDepositLabel: "Initial Deposit ($)",
    submitLabel: "Submit",
    sessionExpiredText: "Your session has expired. Please sign on again.",
    memberNotFoundText: "No member found with ID",
    accessDeniedText: "Access denied.",
    minDepositErrorText: "Initial deposit must be at least $25.00.",
    confirmationBannerText: "Sub-account opened successfully.",
  },
  // A second tenant running the identical underlying app -- rebranded copy AND an extra
  // promo banner row (shifts every position-based DOM path), but the same routes, the
  // same form field name="..."/id="..." attributes, and the same business rules. This is
  // deliberately NOT a fork of the views -- both tenants render the same .ejs templates
  // with different `labels`, the same way one vendor product looks different per tenant.
  "northgate-cu": {
    tenantId: "northgate-cu",
    brandName: "Northgate Credit Union Core",
    bannerText: "Welcome to Northgate Credit Union Member Services",
    operatorIdLabel: "Associate ID",
    passwordLabel: "Passcode",
    signOnLabel: "Log In",
    memberIdLabel: "Member Number",
    lookUpMemberLabel: "Find Member",
    openNewSubAccountLabel: "Open New Account",
    accountTypeLabel: "Account Type",
    initialDepositLabel: "Initial Deposit ($)",
    submitLabel: "Confirm & Open",
    sessionExpiredText: "Your session timed out. Please log in again.",
    memberNotFoundText: "We could not locate a member with number",
    accessDeniedText: "Not authorized to view this member.",
    minDepositErrorText: "Minimum opening deposit is $25.00.",
    confirmationBannerText: "Account opened successfully.",
  },
};

export function getTenantLabels(tenantId: string): TenantLabels {
  return TENANTS[tenantId] ?? TENANTS["mock-bank"]!;
}
