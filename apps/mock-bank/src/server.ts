import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumeSessionTimeoutArm, createSubAccount, findMember, findSubAccount, resetData, subAccounts } from "./data.js";

declare module "express-session" {
  interface SessionData {
    username?: string;
  }
}

// Reserved member ID that simulates a session timing out mid-flow, exactly once per
// resetData() -- a transient glitch, not a permanently broken member.
const TIMEOUT_TRIGGER_ID = "90909";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: "mock-bank-dev-secret-not-sensitive",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 },
  })
);

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
      error: `No member found with ID ${memberId}.`,
      memberId,
    });
    return;
  }
  res.redirect(`/members/${member.id}`);
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
      error: "Initial deposit must be at least $25.00.",
    });
    return;
  }

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

// Test-only: resets in-memory data so discovery/replay runs start from a known state.
// Not present in a real banking app; documented in README as a local-demo affordance.
app.post("/__test__/reset", (_req, res) => {
  resetData();
  res.status(204).end();
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`mock-bank listening on http://localhost:${PORT}`);
});
