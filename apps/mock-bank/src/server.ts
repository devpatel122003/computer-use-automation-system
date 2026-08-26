import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeSubAccount,
  consumeSessionTimeoutArm,
  createMember,
  createSubAccount,
  findMember,
  findSubAccount,
  resetData,
  subAccounts,
  transferFunds,
  type AccountKind,
} from "./data.js";
import { getTenantLabels } from "./tenants.js";

declare module "express-session" {
  interface SessionData {
    username?: string;
  }
}

// Reserved member ID that simulates a session timing out mid-flow, exactly once per
// resetData() -- a transient glitch, not a permanently broken member.
const TIMEOUT_TRIGGER_ID = "90909";

// Which tenant's copy this instance serves -- e.g. TENANT=northgate-cu PORT=4100. Same
// routes, same form field name/id attributes, same business rules; only visible text
// (and, per the view templates, one extra banner row) differs. See tenants.ts.
const labels = getTenantLabels(process.env.TENANT ?? "mock-bank");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

// contentSecurityPolicy off: this app is the automated system's fake *target*, standing in
// for a real third-party bank we don't control -- hardening it isn't the point (see
// SECURITY.md). It's off specifically because legacyWidgetDemo.ejs's inline <canvas> script
// (the vision-fallback negative-control fixture, README step 13) would otherwise be blocked
// by helmet's default script-src.
// hsts: false -- this server is plain HTTP on localhost only, never TLS; helmet's default
// Strict-Transport-Security header is a promise it can't keep. A real bug, reproduced live
// in Safari/WebKit against src/chat-ui/server.ts (same default): the browser believed the
// header and upgraded later same-origin requests to https, which then failed outright.
app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: "mock-bank-dev-secret-not-sensitive",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 },
  })
);

// Every view reads tenant copy from `labels` via res.locals rather than an explicit
// render() argument -- one middleware line instead of threading it through every route.
app.use((_req, res, next) => {
  res.locals.labels = labels;
  next();
});

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.username) {
    res.redirect("/login");
    return;
  }
  next();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.get("/", (req, res) => {
  res.redirect(req.session.username ? "/search" : "/login");
});

app.get("/login", (req, res) => {
  res.render("login", { reason: req.query.reason });
});

app.post("/login", (req, res) => {
  const username = String(req.body.username ?? "").trim();
  const password = String(req.body.password ?? "").trim();
  if (!username || !password) {
    res.render("login", { reason: undefined });
    return;
  }
  req.session.username = username;
  res.redirect("/search");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/search", requireAuth, async (req, res) => {
  const memberId = typeof req.query.memberId === "string" ? req.query.memberId.trim() : "";
  if (!memberId) {
    res.render("search", { username: req.session.username, error: undefined, memberId: "" });
    return;
  }

  if (memberId === TIMEOUT_TRIGGER_ID && consumeSessionTimeoutArm()) {
    req.session.destroy(() => res.redirect("/login?reason=timeout"));
    return;
  }

  const member = findMember(memberId);
  if (!member) {
    res.render("search", {
      username: req.session.username,
      error: `${labels.memberNotFoundText} ${memberId}.`,
      memberId,
    });
    return;
  }
  res.redirect(`/members/${member.id}`);
});

// Registered before /members/:id so "new" is never mistaken for a member id.
app.get("/members/new", requireAuth, (req, res) => {
  res.render("newMember", { username: req.session.username, error: undefined, name: "", initialChecking: "", initialSavings: "" });
});

app.post("/members", requireAuth, (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const rawChecking = String(req.body.initialChecking ?? "").trim();
  const rawSavings = String(req.body.initialSavings ?? "").trim();
  const checkingBalance = rawChecking === "" ? 0 : Number(rawChecking);
  const savingsBalance = rawSavings === "" ? 0 : Number(rawSavings);

  const invalid = !name || Number.isNaN(checkingBalance) || Number.isNaN(savingsBalance) || checkingBalance < 0 || savingsBalance < 0;
  if (invalid) {
    res.render("newMember", {
      username: req.session.username,
      error: labels.newMemberValidationErrorText,
      name,
      initialChecking: rawChecking,
      initialSavings: rawSavings,
    });
    return;
  }

  const member = createMember(name, checkingBalance, savingsBalance);
  res.redirect(`/members/new/confirm/${member.id}`);
});

app.get("/members/new/confirm/:id", requireAuth, (req, res) => {
  const member = findMember(req.params.id);
  if (!member) {
    res.status(404).send("New-member confirmation record not found.");
    return;
  }
  res.render("newMemberConfirmation", { username: req.session.username, member });
});

app.get("/members/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  if (id === TIMEOUT_TRIGGER_ID && consumeSessionTimeoutArm()) {
    req.session.destroy(() => res.redirect("/login?reason=timeout"));
    return;
  }

  const member = findMember(id);
  if (!member) {
    res.redirect(`/search?memberId=${encodeURIComponent(id)}`);
    return;
  }

  if (member.simulateSlow) {
    await delay(3000);
  }

  if (member.permissionRestricted) {
    res.render("member", {
      username: req.session.username,
      accessDenied: true,
      member,
      subAccounts: [],
    });
    return;
  }

  const memberSubAccounts = Array.from(subAccounts.values()).filter((sa) => sa.memberId === member.id);
  res.render("member", {
    username: req.session.username,
    accessDenied: false,
    member,
    subAccounts: memberSubAccounts,
  });
});

app.get("/members/:id/transfer", requireAuth, (req, res) => {
  const { id } = req.params;
  const member = findMember(id);
  if (!member) {
    res.redirect(`/search?memberId=${encodeURIComponent(id)}`);
    return;
  }
  res.render("transferFunds", { username: req.session.username, member, error: undefined, fromAccount: "Checking", toAccount: "Savings", amount: "" });
});

app.post("/members/:id/transfer", requireAuth, (req, res) => {
  const { id } = req.params;
  const member = findMember(id);
  if (!member) {
    res.redirect(`/search?memberId=${encodeURIComponent(id)}`);
    return;
  }

  const fromAccount = String(req.body.fromAccount ?? "Checking") as AccountKind;
  const toAccount = String(req.body.toAccount ?? "Savings") as AccountKind;
  const rawAmount = String(req.body.amount ?? "").trim();
  const amount = Number(rawAmount);

  const result = transferFunds(id, fromAccount, toAccount, amount);
  if (!result.ok) {
    res.render("transferFunds", {
      username: req.session.username,
      member,
      error: result.error === "insufficient_funds" ? labels.insufficientFundsText : labels.invalidTransferText,
      fromAccount,
      toAccount,
      amount: rawAmount,
    });
    return;
  }

  res.redirect(`/members/${id}/transfer/confirm`);
});

app.get("/members/:id/transfer/confirm", requireAuth, (req, res) => {
  const member = findMember(req.params.id);
  if (!member) {
    res.status(404).send("Transfer confirmation record not found.");
    return;
  }
  res.render("transferConfirmation", { username: req.session.username, member });
});

app.get("/members/:id/sub-accounts/new", requireAuth, (req, res) => {
  const { id } = req.params;
  const member = findMember(id);
  if (!member) {
    res.redirect(`/search?memberId=${encodeURIComponent(id)}`);
    return;
  }
  res.render("newSubAccount", { username: req.session.username, memberId: id, error: undefined });
});

app.post("/members/:id/sub-accounts", requireAuth, (req, res) => {
  const { id } = req.params;
  const member = findMember(id);
  if (!member) {
    res.redirect(`/search?memberId=${encodeURIComponent(id)}`);
    return;
  }

  const accountType = String(req.body.accountType ?? "Savings") as "Savings" | "Checking" | "CD";
  const rawDeposit = String(req.body.initialDeposit ?? "").trim();
  const initialDeposit = Number(rawDeposit);

  if (!rawDeposit || Number.isNaN(initialDeposit) || initialDeposit < 25) {
    res.render("newSubAccount", {
      username: req.session.username,
      memberId: id,
      accountType,
      initialDeposit: rawDeposit,
      error: labels.minDepositErrorText,
    });
    return;
  }

  // An unexpected interstitial the recorded flow never accounted for -- see the
  // `requiresInterstitialConfirmation` doc comment in data.ts. Deliberately not something
  // the caller can pass a param to skip: a real unanticipated dialog isn't something the
  // artifact's own inputs could have predicted either.
  if (member.requiresInterstitialConfirmation) {
    res.render("subAccountInterstitial", { username: req.session.username, memberId: id, accountType, initialDeposit: rawDeposit });
    return;
  }

  const record = createSubAccount(id, accountType, initialDeposit);
  res.redirect(`/members/${id}/sub-accounts/${record.id}/confirm`);
});

// Dismissing the interstitial above -- a human's manual action on the live session, not
// something the recorded artifact's own steps ever reach on their own.
app.post("/members/:id/sub-accounts/confirm-interstitial", requireAuth, (req, res) => {
  const { id } = req.params;
  const member = findMember(id);
  if (!member) {
    res.redirect(`/search?memberId=${encodeURIComponent(id)}`);
    return;
  }

  const accountType = String(req.body.accountType ?? "Savings") as "Savings" | "Checking" | "CD";
  const initialDeposit = Number(req.body.initialDeposit ?? "0");

  const record = createSubAccount(id, accountType, initialDeposit);
  res.redirect(`/members/${id}/sub-accounts/${record.id}/confirm`);
});

app.get("/members/:id/sub-accounts/:subId/confirm", requireAuth, (req, res) => {
  const subAccount = findSubAccount(req.params.subId);
  if (!subAccount || subAccount.memberId !== req.params.id) {
    res.status(404).send("Confirmation record not found.");
    return;
  }
  res.render("confirmation", { username: req.session.username, subAccount });
});

app.get("/members/:id/sub-accounts/:subId/close", requireAuth, (req, res) => {
  const member = findMember(req.params.id);
  const subAccount = findSubAccount(req.params.subId);
  if (!member || !subAccount || subAccount.memberId !== member.id) {
    res.status(404).send("Sub-account not found.");
    return;
  }
  res.render("closeSubAccount", { username: req.session.username, member, subAccount, error: undefined });
});

app.post("/members/:id/sub-accounts/:subId/close", requireAuth, (req, res) => {
  const member = findMember(req.params.id);
  const subAccount = findSubAccount(req.params.subId);
  if (!member || !subAccount || subAccount.memberId !== member.id) {
    res.status(404).send("Sub-account not found.");
    return;
  }

  const result = closeSubAccount(subAccount.id);
  if (!result.ok) {
    res.render("closeSubAccount", { username: req.session.username, member, subAccount, error: labels.alreadyClosedText });
    return;
  }

  res.redirect(`/members/${member.id}/sub-accounts/${subAccount.id}/closed`);
});

app.get("/members/:id/sub-accounts/:subId/closed", requireAuth, (req, res) => {
  const member = findMember(req.params.id);
  const subAccount = findSubAccount(req.params.subId);
  if (!member || !subAccount || subAccount.memberId !== member.id) {
    res.status(404).send("Sub-account not found.");
    return;
  }
  res.render("subAccountClosed", { username: req.session.username, member, subAccount });
});

// Test-only: resets in-memory data so discovery/replay runs start from a known state.
// Not present in a real banking app; documented in README as a local-demo affordance.
app.post("/__test__/reset", (_req, res) => {
  resetData();
  res.status(204).end();
});

// A deliberate negative-control fixture for the vision-grounded replay fallback (see
// legacyWidgetDemo.ejs's own header comment) -- not a real banking feature, no auth
// required, isolated from the rest of the app on purpose.
app.get("/legacy-widget-demo", (_req, res) => {
  res.render("legacyWidgetDemo");
});
app.get("/legacy-widget-demo/confirmed", (_req, res) => {
  res.render("legacyWidgetConfirmed");
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`mock-bank listening on http://localhost:${PORT} (tenant: ${labels.tenantId})`);
});
