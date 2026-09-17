// §QUICK-ADD — the two lookups a phone shortcut needs before it writes. See `services/quick-add.ts`.
import type { AppDb } from "../lib/platform/db-shim.ts";

export interface QuickAddAccount { id: string; title: string | null; currency_code: number; is_manual: number }

export async function activeAccounts(db: AppDb): Promise<QuickAddAccount[]> {
  const r = await db.prepare(
    "SELECT id, title, currency_code, COALESCE(is_manual, 0) AS is_manual FROM accounts WHERE is_active = 1",
  ).all<QuickAddAccount>();
  return r.results ?? [];
}

/**
 * An operation of this exact signed amount already recorded near `at`: by a bank feed or by hand
 * within `bankWindow`, or by this same shortcut within `repeatWindow` (a Wallet automation that
 * fired twice). Returns its id.
 */
export async function nearbyDuplicate(
  db: AppDb, amount: number, at: number, bankWindow: number, repeatWindow: number,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT id FROM transactions
     WHERE amount = ?
       AND ((source <> 'shortcut' AND ABS(time - ?) <= ?) OR (source = 'shortcut' AND ABS(time - ?) <= ?))
     ORDER BY ABS(time - ?) LIMIT 1`,
  ).bind(amount, at, bankWindow, at, repeatWindow, at).first<{ id: string }>();
  return row?.id ?? null;
}
