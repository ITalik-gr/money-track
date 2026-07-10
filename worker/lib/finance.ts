// Спільна бізнес-логіка фінансів, яку викликають і HTTP-API (routes/api.ts), і
// Telegram-бот (routes/telegram.ts): створення готівкової транзакції, підсумок
// власних коштів (§5, кредитний ліміт) і останні транзакції. Одне джерело правди.
import type { Env } from "../env.ts";

// §R2-CUR2: єдине джерело правди для зведення сум у гривню. rates — мапа
// «код валюти → скільки ₴ за 1 одиницю» (див. cron/rates). Суми в мінімальних
// одиницях (копійки/центи); множення на курс дає ₴-копійки без ділення на 100.
export type Rates = Record<string, number>;

export async function getRates(db: D1Database): Promise<Rates> {
  const raw = await db
    .prepare("SELECT value FROM app_state WHERE key = 'rates'")
    .first<{ value: string }>();
  return raw ? (JSON.parse(raw.value) as Rates) : {};
}

/** Convert a minor-unit amount in `code` to UAH minor units. 0 rate → 0 (unknown). */
export function toUAHMinor(amountMinor: number, code: number, rates: Rates): number {
  if (code === 980) return amountMinor;
  const rate = rates[String(code)] ?? 0;
  return Math.round(amountMinor * rate);
}

// Find or create the dedicated cash account so cash entries never land on a card.
export async function ensureCashAccount(db: D1Database, currency = 980): Promise<string> {
  const existing = await db.prepare("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1").first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual, is_active, updated_at)
     VALUES (?, 'cash', 'Готівка', ?, 0, 0, 1, 1, ?)`,
  ).bind(id, currency, Math.floor(Date.now() / 1000)).run();
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
export async function createCashTx(db: D1Database, b: NewTxInput): Promise<string> {
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

  for (const a of accounts.results ?? []) {
    const creditLimit = a.credit_limit ?? 0;
    const own = (a.balance ?? 0) - creditLimit;
    byCurrency.set(a.currency_code, (byCurrency.get(a.currency_code) ?? 0) + own);
    if (creditLimit > 0 && a.type === "black") {
      credit = { accountId: a.id, limit: creditLimit, own, debt: own < 0 ? -own : 0 };
    }
  }

  const rates = await getRates(env.DB);
  let totalUAH = 0;
  for (const [code, own] of byCurrency) {
    totalUAH += toUAHMinor(own, code, rates);
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
export async function recentTransactions(db: D1Database, limit = 10): Promise<RecentTx[]> {
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
