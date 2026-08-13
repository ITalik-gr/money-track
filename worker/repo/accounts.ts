// Account reads. See `worker/repo/README.md` for why this layer exists.
//
// Signatures take `AppDb`, not `Env`: the narrower dependency is what makes a repository
// function callable straight from a test, and it keeps the layer honest — a repo function that
// needed the whole environment would be doing more than fetching rows.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { Account } from "../../shared/types.ts";

/**
 * A row of `accounts`, i.e. the CONTRACT type — these queries are `SELECT *`, so the response
 * carries every column and there is nothing to narrow.
 *
 * It used to be a hand-written half-type here with an `[key: string]: unknown` escape hatch,
 * listing 9 of the table's 16 columns. That is defect D2 one layer down: the client believed it
 * received `provider`, `iban` and the credit-card terms, the repo's type said they did not exist,
 * and `tsc` could not compare the two because neither side imported the other. The alias keeps
 * the old name working for the ~20 call sites inside this module.
 */
export type AccountRow = Account;

export async function listActive(db: AppDb): Promise<AccountRow[]> {
  const r = await db.prepare(
    "SELECT * FROM accounts WHERE is_active = 1 ORDER BY is_manual, type",
  ).all<AccountRow>();
  return r.results ?? [];
}

export async function listArchived(db: AppDb): Promise<AccountRow[]> {
  const r = await db.prepare(
    "SELECT * FROM accounts WHERE is_active = 0 ORDER BY is_manual, type",
  ).all<AccountRow>();
  return r.results ?? [];
}

export interface NetWorthAccount {
  id: string;
  title: string | null;
  type: string | null;
  role: string | null;
  balance: number;
  credit_limit: number;
  currency_code: number;
  is_manual: number;
}

/** Active accounts with just the columns net-worth reconstruction needs. */
export async function listForNetWorth(db: AppDb): Promise<NetWorthAccount[]> {
  const r = await db.prepare(
    `SELECT id, title, type, role, balance, credit_limit, currency_code, is_manual
     FROM accounts WHERE is_active = 1`,
  ).all<NetWorthAccount>();
  return r.results ?? [];
}

export interface BalancePoint { acc: string; balance: number; at: number }

/**
 * Balance snapshots for every account, oldest first.
 *
 * Returns `null` — not an empty array — when the table is missing, because the caller has to
 * tell "no history recorded" apart from "this deployment has not run migration 0026 yet" and
 * answer differently. Swallowing that distinction here would make a missing migration look like
 * an account with no history.
 */
export async function balanceHistory(db: AppDb): Promise<BalancePoint[] | null> {
  try {
    const r = await db.prepare(
      "SELECT account_id AS acc, balance, recorded_at AS at FROM account_balance_history ORDER BY account_id, recorded_at",
    ).all<BalancePoint>();
    return r.results ?? [];
  } catch {
    return null;
  }
}

/** Currency of specific accounts — the manual-transfer route needs both sides before writing. */
export async function currenciesFor(
  db: AppDb, ids: string[],
): Promise<{ id: string; currency_code: number }[]> {
  const r = await db.prepare(
    `SELECT id, currency_code FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<{ id: string; currency_code: number }>();
  return r.results ?? [];
}

// ---- writes -----------------------------------------------------------------

export interface NewManualAccount {
  id: string;
  type: string;
  title: string;
  currency_code: number;
  balance: number;
  credit_limit: number;
  role: string;
  ai_note: string | null;
  updated_at: number;
}

export async function createManual(db: AppDb, a: NewManualAccount): Promise<void> {
  await db.prepare(
    // `provider` is stated, never left to the column DEFAULT ('mono' — see migration 0042): a
    // default that was harmless with one bank silently marked every hand-added account as a
    // monobank one, and the Accounts page groups by exactly this column.
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, role, ai_note, provider, is_manual, is_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, 1, ?)`,
  ).bind(a.id, a.type, a.title, a.currency_code, a.balance, a.credit_limit, a.role, a.ai_note, a.updated_at).run();
}

/**
 * Balance / title of a MANUAL account.
 *
 * `is_manual = 1` is part of the WHERE clause, not a check in the handler: a bank-synced balance
 * is the bank's to state, and a client that could set it would make the account disagree with the
 * statement it is reconciled against.
 *
 * @returns false when the patch was empty, so the caller can skip the write.
 */
export async function updateManual(
  db: AppDb, id: string, patch: { balance?: number; title?: string }, updatedAt: number,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["balance", "title"] as const) {
    const v = patch[col];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (!sets.length) return false;
  sets.push("updated_at = ?"); binds.push(updatedAt);
  await db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ? AND is_manual = 1`)
    .bind(...binds, id).run();
  return true;
}

/** Display name only, so it is allowed on any account — the bank sync no longer overwrites it. */
export async function rename(db: AppDb, id: string, title: string): Promise<void> {
  await db.prepare("UPDATE accounts SET title = ? WHERE id = ?").bind(title, id).run();
}

/** §R3 role and AI note, plus the credit-card terms that feed the payment reminder. */
export interface AccountMeta {
  role?: string;
  ai_note?: string | null;
  statement_day?: number | null;
  payment_day?: number | null;
  min_payment?: number | null;
}

export async function updateMeta(db: AppDb, id: string, meta: AccountMeta): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["role", "ai_note", "statement_day", "payment_day", "min_payment"] as const) {
    const v = meta[col];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (!sets.length) return false;
  await db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return true;
}

/** Archive / restore. The transaction history is untouched — the account just leaves the lists. */
export async function setActive(db: AppDb, id: string, active: boolean): Promise<void> {
  await db.prepare("UPDATE accounts SET is_active = ? WHERE id = ?").bind(active ? 1 : 0, id).run();
}

/**
 * Set the balance from a bank event's post-transaction balance.
 *
 * Separate from the sync path on purpose: a webhook event carries the balance AFTER its own
 * operation, which is fresher than anything the last client-info fetch knows. Without this the
 * feed would show an operation the dashboard's total has not accounted for yet, and the two
 * screens would disagree for as long as it takes the next sync to run.
 */
export async function applyEventBalance(
  db: AppDb, id: string, balance: number, at: number,
): Promise<void> {
  await db.prepare("UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?")
    .bind(balance, at, id).run();
}

/**
 * Identity and currency of one account, or null when there is no such account.
 *
 * This is what the CSV import asks before converting a statement: the ACCOUNT decides the currency
 * of every imported row, never the file. A statement carries no reliable currency of its own, and
 * the canon converts by `transactions.currency_code` — so taking it from anywhere else would show
 * up much later, as a wrong total rather than as an import error.
 */
export async function findForImport(
  db: AppDb, id: string,
): Promise<{ id: string; currency_code: number | null } | null> {
  return await db.prepare("SELECT id, currency_code FROM accounts WHERE id = ?")
    .bind(id).first<{ id: string; currency_code: number | null }>();
}

export async function findKind(db: AppDb, id: string): Promise<{ is_manual: number } | null> {
  return await db.prepare("SELECT is_manual FROM accounts WHERE id = ?").bind(id).first<{ is_manual: number }>();
}

export async function transactionCount(db: AppDb, id: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?")
    .bind(id).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Hard delete, and only ever a manual account with no transactions — the caller checks both
 * before calling. `is_manual = 1` is repeated in the WHERE clause as a second lock: this is the
 * one statement here that cannot be undone.
 */
export async function removeManual(db: AppDb, id: string): Promise<void> {
  await db.prepare("DELETE FROM accounts WHERE id = ? AND is_manual = 1").bind(id).run();
}

/**
 * Record a balance snapshot, at most one per day.
 *
 * The same day is REPLACED rather than appended, so a run of corrections in one sitting leaves a
 * single point and the net-worth line steps by day instead of by edit.
 */
export async function recordBalance(
  db: AppDb, accountId: string, balance: number, at: number,
): Promise<void> {
  const dayStart = at - (at % 86400);
  await db.prepare(
    "DELETE FROM account_balance_history WHERE account_id = ? AND recorded_at >= ? AND recorded_at < ?",
  ).bind(accountId, dayStart, dayStart + 86400).run();
  await db.prepare(
    "INSERT INTO account_balance_history (account_id, balance, recorded_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(accountId, balance, at, at).run();
}

/**
 * Upserts accounts a provider reported (BANKS.md §5, step 7).
 *
 * Generic counterpart to `finance/repo.ts` `syncAccounts`, which is monobank-shaped. Two rules
 * carried over deliberately:
 *   • **the title is written only on INSERT** (`COALESCE`) — a hand-renamed account must survive
 *     every later sync, and a bank's own name for an account is often a generic one;
 *   • **`is_manual` accounts are never touched** — that is the guarantee that a hand-kept cash
 *     account cannot have its balance overwritten by an API that has never heard of it.
 */
export async function upsertProviderAccounts(
  db: AppDb,
  providerId: string,
  accounts: {
    id: string; type: string | null; title: string | null;
    currency_code: number | null; balance: number | null; credit_limit: number | null; iban?: string | null;
  }[],
): Promise<void> {
  if (!accounts.length) return;
  const now = Math.floor(Date.now() / 1000);
  await db.batch(accounts.map((a) =>
    db.prepare(
      `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, iban,
                             provider, is_manual, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = COALESCE(accounts.type, excluded.type),
         title = COALESCE(accounts.title, excluded.title),
         currency_code = excluded.currency_code,
         balance = excluded.balance,
         credit_limit = excluded.credit_limit,
         iban = COALESCE(excluded.iban, accounts.iban),
         provider = excluded.provider,
         updated_at = excluded.updated_at
       WHERE accounts.is_manual = 0`,
    ).bind(
      a.id, a.type, a.title, a.currency_code, a.balance ?? 0, a.credit_limit ?? 0,
      a.iban ?? null, providerId, now,
    ),
  ));
}
