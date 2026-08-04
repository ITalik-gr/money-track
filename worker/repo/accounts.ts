// Account reads. See `worker/repo/README.md` for why this layer exists.
//
// Signatures take `AppDb`, not `Env`: the narrower dependency is what makes a repository
// function callable straight from a test, and it keeps the layer honest — a repo function that
// needed the whole environment would be doing more than fetching rows.
import type { AppDb } from "../lib/platform/db-shim.ts";

export interface AccountRow {
  id: string;
  type: string | null;
  title: string | null;
  currency_code: number;
  balance: number;
  credit_limit: number;
  is_manual: number;
  is_active: number;
  role: string | null;
  [key: string]: unknown;
}

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
