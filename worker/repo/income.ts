// Income reads — the four queries behind `/analytics/income`. Split out of `repo/analytics.ts` on
// 2026-09-25 (C3: that file may only shrink) when the stability chart gained per-month sources.
// Same rule as its parent: compose the canon from `lib/finance/stats.ts`, never restate it.
import type { AppDb } from "../lib/platform/db-shim.ts";
import { STATS_JOINS, INCOME_WHERE, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, incomeSum, localYmSql } from "../lib/finance/stats.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
import type { ValueScope, Range } from "./analytics.ts";

export interface IncomeSource {
  category_id: number | null; name: string | null; color: string | null; amount: number; n: number;
}

/**
 * Income broken down by effective category.
 *
 * Uses the canonical `incomeSum`, which is the whole point: it summed raw `SUM(t.amount)` until
 * 2026-08-07, so it did NOT subtract `reimburses_total` (§COMPENSATION) the way the period total
 * beside it does. An incoming payment partly allocated to expenses appeared in FULL in its
 * category row but only as its remainder in the total — and the percentages, computed against
 * that total, added up to more than 100%. On the fixture: 47 700 ₴ total against 48 700 ₴ of
 * sources, i.e. **102%** on screen.
 *
 * Found by the golden fixture rather than by eye, because the fixture deliberately contains a
 * partial reimbursement. It is the §CUR-PLAN mechanism in miniature: a local restatement of the
 * canon, sitting one function away from the canon itself, drifting quietly.
 */
export async function incomeBySource(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<IncomeSource[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(locale, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color,
            ${incomeSum(v.mult)} AS amount, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${INCOME_WHERE}${v.curFilter}
     GROUP BY ${EFF_CAT_ID} ORDER BY amount DESC`,
  ).bind(r.from, r.to).all<IncomeSource>();
  return res.results ?? [];
}

/** Canonical income for a window. Called twice per request (current and previous period). */
export async function incomeTotal(
  db: AppDb, v: ValueScope, r: Range,
): Promise<{ income: number } | null> {
  return await db.prepare(
    `SELECT ${incomeSum(v.mult)} AS income FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?${v.curFilter}`,
  ).bind(r.from, r.to).first<{ income: number }>();
}

/** Income per calendar month — the input to the stability (coefficient-of-variation) estimate. */
export async function monthlyIncome(
  db: AppDb, v: ValueScope, now: number, r: Range,
): Promise<{ m: string; income: number }[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS m, ${incomeSum(v.mult)} AS income
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?${v.curFilter} GROUP BY m ORDER BY m`,
  ).bind(r.from, r.to).all<{ m: string; income: number }>();
  return res.results ?? [];
}

/**
 * Income per calendar month AND source — what the stability chart's tooltip names (UI_PASS ST5):
 * «a jumpy month» means nothing until it says which payment was missing or doubled.
 */
export async function monthlyIncomeBySource(
  db: AppDb, locale: NotifLocale, v: ValueScope, now: number, r: Range,
): Promise<{ m: string; name: string | null; amount: number }[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS m, ${catNameSql(locale, EFF_CAT_NAME)} AS name, ${incomeSum(v.mult)} AS amount
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${INCOME_WHERE}${v.curFilter}
     GROUP BY m, ${EFF_CAT_ID} ORDER BY m, amount DESC`,
  ).bind(r.from, r.to).all<{ m: string; name: string | null; amount: number }>();
  return res.results ?? [];
}
