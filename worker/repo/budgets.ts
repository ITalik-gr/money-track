// Budget envelopes. See `worker/repo/README.md`.
//
// This module only stores and lists the LIMITS. How much of an envelope has been eaten is
// canon — `budgetStatus()` in `lib/finance/stats.ts` — and is not restated here. The weekly
// Telegram push once had its own SQL for exactly that and reported different numbers than the
// notification feed for the same budgets.
import type { AppDb } from "../lib/platform/db-shim.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
import type { Budget } from "../../shared/types.ts";

export async function listAll(db: AppDb): Promise<Budget[]> {
  const r = await db.prepare("SELECT * FROM budgets").all<Budget>();
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

/**
 * Apply several monthly envelopes at once, with the same replace semantics as `set`.
 *
 * ⚠️ **The rollover flag SURVIVES.** This used to write a literal `0`, so accepting an auto-budget
 * silently switched off §BUDGET-MEMORY on every envelope it touched — the limit changed, which is
 * what the user asked for, and the carry-over quietly stopped, which they never did. A batch that
 * replaces a row is not permission to reset the settings that row was carrying.
 */
export async function setMonthlyBatch(
  db: AppDb, items: { category_id: number; amount: number }[],
): Promise<void> {
  const existing = await monthlyEnvelopes(db);
  await db.batch(items.flatMap((i) => [
    db.prepare("DELETE FROM budgets WHERE category_id = ? AND period = 'month'").bind(i.category_id),
    db.prepare("INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, 'month', ?, 980, ?)")
      .bind(i.category_id, i.amount, existing.get(i.category_id)?.rollover ? 1 : 0),
  ]));
}

/**
 * §BUDGET-MEMORY — the TRACK RECORD of each envelope: how many closed months it had, how many it
 * blew, and what it actually spent on average.
 *
 * This is the thing an auto-budget could never know. Proposing a limit from spending alone means
 * proposing the same "level − 10%" to someone who has missed that target four months running —
 * the app repeating a number already proven unachievable, which is how a budget stops being read.
 */
export async function trackRecord(
  db: AppDb, sinceYm: string,
): Promise<Map<number, { closed: number; over: number; avg_spent: number; avg_limit: number }>> {
  // Bounded by the MONTH KEY, not by a row count: `LIMIT n` would have to guess how many
  // categories carry envelopes, and the guess decides how far back the window really reaches.
  const r = await db.prepare(
    `SELECT category_id,
            COUNT(*)                                                          AS closed,
            SUM(CASE WHEN spent_minor > limit_minor + carry_in_minor THEN 1 ELSE 0 END) AS over,
            AVG(spent_minor)                                                  AS avg_spent,
            AVG(limit_minor + carry_in_minor)                                 AS avg_limit
     FROM budget_months WHERE ym >= ?
     GROUP BY category_id`,
  ).bind(sinceYm).all<{ category_id: number; closed: number; over: number; avg_spent: number; avg_limit: number }>();
  return new Map((r.results ?? []).map((x) => [x.category_id, {
    closed: x.closed, over: x.over,
    avg_spent: Math.round(x.avg_spent), avg_limit: Math.round(x.avg_limit),
  }]));
}

// ---- §BUDGET-MEMORY: closed months -----------------------------------------

export interface BudgetMonth {
  ym: string;
  category_id: number;
  limit_minor: number;
  carry_in_minor: number;
  spent_minor: number;
}

/** Monthly limits AND their rollover flag — what `budgetStatus` needs to open a month. */
export async function monthlyEnvelopes(
  db: AppDb,
): Promise<Map<number, { amount: number; rollover: boolean }>> {
  const r = await db.prepare(
    // §BUDGET-ZERO: `>= 0`, not `> 0`. A stored row IS the envelope; its absence is "no envelope".
    // A zero row is a real, deliberate limit — "I do not spend here" — and filtering it out is how
    // that statement used to be indistinguishable from never having made one.
    "SELECT category_id, amount, COALESCE(rollover, 0) AS rollover FROM budgets WHERE period = 'month' AND amount >= 0",
  ).all<{ category_id: number; amount: number; rollover: number }>();
  return new Map((r.results ?? []).map((b) => [b.category_id, { amount: b.amount, rollover: !!b.rollover }]));
}

/** The closed row for ONE month, keyed by category — the carry-in lookup. */
export async function closedMonth(db: AppDb, ym: string): Promise<Map<number, BudgetMonth>> {
  const r = await db.prepare(
    `SELECT ym, category_id, limit_minor, carry_in_minor, spent_minor
     FROM budget_months WHERE ym = ?`,
  ).bind(ym).all<BudgetMonth>();
  return new Map((r.results ?? []).map((m) => [m.category_id, m]));
}

/** One envelope's recent closed months, oldest first — the history strip reads left to right. */
export async function monthsForCategory(
  db: AppDb, categoryId: number, limit = 6,
): Promise<BudgetMonth[]> {
  const r = await db.prepare(
    `SELECT ym, category_id, limit_minor, carry_in_minor, spent_minor
     FROM budget_months WHERE category_id = ? ORDER BY ym DESC LIMIT ?`,
  ).bind(categoryId, limit).all<BudgetMonth>();
  return (r.results ?? []).reverse();
}

/**
 * Every closed month since `sinceYm`, with the category it belongs to — the whole-plan view.
 *
 * `monthsForCategory` answers «як цей конверт закривався»; this answers «чи я взагалі тримаю
 * план», which is a different question and the one nothing could answer until now. The table has
 * existed since migration 0043 and had exactly two readers: the auto-budget's `trackRecord` (which
 * throws the months away and keeps a ratio) and the six-month strip on one category page.
 *
 * The name is resolved HERE rather than by the caller, through `catNameSql` like every other
 * category name that reaches a screen (§LANG-ARCH: `repo/*` resolves, `lib/ai/*` used not to, and
 * that was the bug).
 */
export interface BudgetMonthNamed extends BudgetMonth {
  name: string;
  color: string | null;
}

export async function monthsSince(
  db: AppDb, locale: NotifLocale, sinceYm: string,
): Promise<BudgetMonthNamed[]> {
  const r = await db.prepare(
    `SELECT m.ym, m.category_id, m.limit_minor, m.carry_in_minor, m.spent_minor,
            ${catNameSql(locale, "c.name")} AS name, c.color AS color
     FROM budget_months m JOIN categories c ON c.id = m.category_id
     WHERE m.ym >= ? ORDER BY m.ym ASC`,
  ).bind(sinceYm).all<BudgetMonthNamed>();
  return r.results ?? [];
}

/** True once ANY envelope has a row for this month — the close is a no-op after that. */
export async function monthIsClosed(db: AppDb, ym: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 FROM budget_months WHERE ym = ? LIMIT 1").bind(ym).first();
  return r != null;
}

/**
 * Record a closed month. `INSERT OR IGNORE`, so the daily pass that runs the close can run any
 * number of times: the first one after the month turns over writes the row, every later one is a
 * no-op. Re-closing would be worse than not closing — the spend of a finished month keeps moving
 * as old rows get re-categorised, and the carry chain is built on this number.
 */
export async function closeMonth(db: AppDb, rows: BudgetMonth[], closedAt: number): Promise<void> {
  if (!rows.length) return;
  await db.batch(rows.map((m) => db.prepare(
    `INSERT OR IGNORE INTO budget_months
       (ym, category_id, limit_minor, carry_in_minor, spent_minor, closed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(m.ym, m.category_id, m.limit_minor, m.carry_in_minor, m.spent_minor, closedAt)));
}
