// Budget envelopes. See `worker/repo/README.md`.
//
// This module only stores and lists the LIMITS. How much of an envelope has been eaten is
// canon — `budgetStatus()` in `lib/finance/stats.ts` — and is not restated here. The weekly
// Telegram push once had its own SQL for exactly that and reported different numbers than the
// notification feed for the same budgets.
import type { AppDb } from "../lib/platform/db-shim.ts";

export async function listAll(db: AppDb): Promise<Record<string, unknown>[]> {
  const r = await db.prepare("SELECT * FROM budgets").all();
  return r.results ?? [];
}

/** Monthly limits keyed by category — the "current" column of the auto-budget proposal. */
export async function monthlyAmounts(db: AppDb): Promise<Map<number, number>> {
  const r = await db.prepare("SELECT category_id, amount FROM budgets WHERE period = 'month'")
    .all<{ category_id: number; amount: number }>();
  return new Map((r.results ?? []).map((b) => [b.category_id, b.amount]));
}

/**
 * Idempotent set: at most one envelope per (category, period).
 *
 * The table carries NO unique index, so this is delete-then-insert in a batch rather than an
 * upsert. Both statements go in one batch on purpose — a delete that committed on its own would
 * leave the user with no envelope at all if the insert then failed.
 */
export async function set(
  db: AppDb, categoryId: number, period: string, amount: number, rollover: boolean,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM budgets WHERE category_id = ? AND period = ?").bind(categoryId, period),
    db.prepare("INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, ?, ?, 980, ?)")
      .bind(categoryId, period, amount, rollover ? 1 : 0),
  ]);
}

/** A non-positive amount is how the UI says "no envelope here". */
export async function clear(db: AppDb, categoryId: number, period: string): Promise<void> {
  await db.prepare("DELETE FROM budgets WHERE category_id = ? AND period = ?")
    .bind(categoryId, period).run();
}

/** Apply several monthly envelopes at once, with the same replace semantics as `set`. */
export async function setMonthlyBatch(
  db: AppDb, items: { category_id: number; amount: number }[],
): Promise<void> {
  await db.batch(items.flatMap((i) => [
    db.prepare("DELETE FROM budgets WHERE category_id = ? AND period = 'month'").bind(i.category_id),
    db.prepare("INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, 'month', ?, 980, 0)")
      .bind(i.category_id, i.amount),
  ]));
}
