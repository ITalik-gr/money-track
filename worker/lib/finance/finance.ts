// Спільна бізнес-логіка фінансів, яку викликають і HTTP-API (routes/api.ts), і
// Telegram-бот (routes/telegram.ts): створення готівкової транзакції, підсумок
// власних коштів (§5, кредитний ліміт) і останні транзакції. Одне джерело правди.
import type { Env } from "../../env.ts";
import { ownFundsMinor, debtMinor } from "./own-funds.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { getState } from "./repo.ts";
import { getRates, toBaseMinor } from "./money.ts";

// Find or create the dedicated cash account so cash entries never land on a card.
//
// The title is written ONCE, at creation, in whatever locale the owner had then (B3) — it is
// stored user data from that point on, and renaming it is the owner's call. Localizing it on
// read would be wrong for the same reason: it would silently rename an account the user may
// have deliberately called something else.
export async function ensureCashAccount(db: AppDb, currency = 980): Promise<string> {
  const existing = await db.prepare("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1").first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const title = (await getState(db, "locale")) === "en" ? "Cash" : "Готівка";
  await db.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual, is_active, updated_at)
     VALUES (?, 'cash', ?, ?, 0, 0, 1, 1, ?)`,
  ).bind(id, title, currency, Math.floor(Date.now() / 1000)).run();
  return id;
}

export interface NewTxInput {
  account_id?: string;
  amount: number;            // minor units, sign included (витрата = від'ємна)
  currency_code?: number;
  time?: number;
  merchant?: string | null;
  category_id?: number | null;
  user_note?: string | null;
  source?: string;           // 'cash' | 'manual' | ...
}

// Create a manual/cash transaction. source='cash' routes to the cash account.
export async function createCashTx(db: AppDb, b: NewTxInput): Promise<string> {
  const source = b.source ?? "cash";
  const accountId = source === "cash"
    ? await ensureCashAccount(db, b.currency_code ?? 980)
    : b.account_id;
  if (!accountId) throw new Error("account_id required");

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, merchant, user_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, accountId, source, b.time ?? now, b.amount,
    b.currency_code ?? 980, b.category_id ?? null, b.merchant ?? null, b.user_note ?? null, now,
  ).run();
  return id;
}

export interface Summary {
  byCurrency: { currency_code: number; own: number }[];
  totalUAH: number;
  credit: { accountId: string; limit: number; own: number; debt: number } | null;
}

// Net-worth summary with §5 credit-limit handling: mono card balance includes the
// credit limit, so own funds = balance − creditLimit; convert to UAH via cached rates.
export async function computeSummary(env: Env): Promise<Summary> {
  const accounts = await env.DB.prepare(
    "SELECT id, type, balance, credit_limit, currency_code FROM accounts WHERE is_active = 1",
  ).all<{ id: string; type: string; balance: number; credit_limit: number; currency_code: number }>();

  const byCurrency = new Map<number, number>();
  let credit: Summary["credit"] = null;
  const rates = await getRates(env);

  for (const a of accounts.results ?? []) {
    const creditLimit = a.credit_limit ?? 0;
    const own = ownFundsMinor(a.balance, creditLimit);
    byCurrency.set(a.currency_code, (byCurrency.get(a.currency_code) ?? 0) + own);
    if (creditLimit > 0 && a.type === "black") {
      // §BASE-CUR: the card's three figures are ROLLED UP like the total, not left in the card's
      // own currency — the banner prints them under one sign, so one un-converted number there
      // would be a limit and a debt in different units sitting next to each other.
      const conv = (v: number) => toBaseMinor(v, a.currency_code, rates);
      credit = {
        accountId: a.id, limit: conv(creditLimit), own: conv(own),
        debt: conv(debtMinor(a.balance, creditLimit)),
      };
    }
  }

  let totalUAH = 0;
  for (const [code, own] of byCurrency) {
    totalUAH += toBaseMinor(own, code, rates);
  }

  return {
    byCurrency: [...byCurrency].map(([currency_code, own]) => ({ currency_code, own })),
    totalUAH: Math.round(totalUAH),
    credit,
  };
}

export interface RecentTx {
  id: string;
  time: number;
  amount: number;
  currency_code: number;
  merchant: string | null;
  comment: string | null;
  category_name: string | null;
  is_transfer: number;
}

// Latest settled transactions (excludes holds) — for /last and quick lists.
export async function recentTransactions(db: AppDb, limit = 10): Promise<RecentTx[]> {
  const rows = await db.prepare(
    `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment, t.is_transfer,
            c.name AS category_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.hold = 0
     ORDER BY t.time DESC LIMIT ?`,
  ).bind(limit).all<RecentTx>();
  return rows.results ?? [];
}
