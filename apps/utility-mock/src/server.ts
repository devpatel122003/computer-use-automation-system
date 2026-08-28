import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAccount, recordMeterReading, resetData } from "./data.js";

declare module "express-session" {
  interface SessionData {
    agentId?: string;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: "gridpoint-dev-secret-not-sensitive",
    resave: false,
    saveUninitialized: false,
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.agentId) {
    res.redirect("/login");
    return;
  }
  next();
}

app.get("/login", (_req, res) => {
  res.render("login", { error: undefined });
});

app.post("/login", (req, res) => {
  const agentId = String(req.body.agentId ?? "").trim();
  const pin = String(req.body.pin ?? "").trim();
  if (!agentId || !pin) {
    res.render("login", { error: "Agent ID and PIN are both required." });
    return;
  }
  req.session.agentId = agentId;
  res.redirect("/accounts");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/accounts", requireAuth, (req, res) => {
  const accountNumber = typeof req.query.accountNumber === "string" ? req.query.accountNumber.trim() : "";
  if (!accountNumber) {
    res.render("accountSearch", { agentId: req.session.agentId, error: undefined, accountNumber: "" });
    return;
  }
  const account = findAccount(accountNumber);
  if (!account) {
    res.render("accountSearch", { agentId: req.session.agentId, error: `No account on file for "${accountNumber}".`, accountNumber });
    return;
  }
  res.redirect(`/accounts/${account.id}`);
});

app.get("/accounts/:id", requireAuth, (req, res) => {
  const account = findAccount(req.params.id);
  if (!account) {
    res.redirect(`/accounts?accountNumber=${encodeURIComponent(req.params.id)}`);
    return;
  }
  res.render("account", { agentId: req.session.agentId, account });
});

app.get("/accounts/:id/meter-reading/new", requireAuth, (req, res) => {
  const account = findAccount(req.params.id);
  if (!account) {
    res.status(404).send("Account not found.");
    return;
  }
  res.render("meterReadingNew", { agentId: req.session.agentId, account, error: undefined, newReading: "" });
});

app.post("/accounts/:id/meter-reading", requireAuth, (req, res) => {
  const account = findAccount(req.params.id);
  if (!account) {
    res.status(404).send("Account not found.");
    return;
  }

  if (account.status === "SUSPENDED") {
    res.render("meterReadingNew", {
      agentId: req.session.agentId,
      account,
      error: "ACCOUNT SUSPENDED -- service actions are disabled for this account.",
      newReading: String(req.body.newReading ?? ""),
    });
    return;
  }

  const raw = String(req.body.newReading ?? "").trim();
  const newReading = Number(raw);
  if (!raw || Number.isNaN(newReading) || newReading < 0) {
    res.render("meterReadingNew", {
      agentId: req.session.agentId,
      account,
      error: "READING REJECTED -- enter a valid, non-negative number.",
      newReading: raw,
    });
    return;
  }
  if (newReading < account.meterReading) {
    res.render("meterReadingNew", {
      agentId: req.session.agentId,
      account,
      error: `READING REJECTED -- the new reading cannot be lower than the reading on file (${account.meterReading}).`,
      newReading: raw,
    });
    return;
  }

  recordMeterReading(account.id, newReading);
  res.render("meterReadingConfirm", { agentId: req.session.agentId, account });
});

// Same escape hatch as apps/mock-bank's own /__test__/reset -- returns to clean seed data.
app.post("/__test__/reset", (_req, res) => {
  resetData();
  res.status(204).send();
});

const PORT = Number(process.env.PORT ?? 4300);
app.listen(PORT, () => {
  console.log(`GridPoint Utility Co-op mock server listening on http://localhost:${PORT}`);
});
