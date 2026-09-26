// Single-merchant reads — the queries behind `/analytics/merchant`. Split out of
// `repo/analytics.ts` on 2026-09-26 (C3: that file may only shrink) when the page learned the
// income side. Same rule as its parent: compose the canon from `lib/finance/stats.ts`, never
// restate it.
//
// Every aggregate runs over ALL of the merchant's rows and lets the canonical CASE-sums pick the
// side. The page used to filter by `SPEND_WHERE` in the WHERE clause, so an employer paying a
// salary read as "spent 0 ₴ in 0 operations" above a list of three incoming payments.
import type { AppDb } from "../lib/platform/db-shim.ts";
import {
  STATS_JOINS, SPEND_WHERE, INCOME_WHERE, IS_REFUND, EFF_AMOUNT, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR,
  spendSum, incomeSum, localYmSql,
} from "../lib/finance/stats.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
import type { TxRow } from "../../shared/api/transactions.ts";

export type MerchantSideKey = "spend" | "income";

/** A real debit (a refund passes `SPEND_WHERE` with a positive amount, and is not a visit). */
const DEBIT = `(${SPEND_WHERE}) AND ${EFF_AMOUNT} < 0`;
const REFUND = `(${SPEND_WHERE}) AND ${IS_REFUND}`;

export interface MerchantAggregate {
  spent: number; spend_n: number; spend_first: number | null; spend_last: number | null;
  income: number; income_n: number; income_first: number | null; income_last: number | null;
  refunds: number; refund_n: number;
  /** Rows neither side counts: own-money moves, transfer pairs, fully allocated compensations. */
  other_n: number;
  total_n: number;
}

export async function merchantAggregate(db: AppDb, mult: string, name: string): Promise<MerchantAggregate | null> {
  // `COUNT(DISTINCT … t.id)` everywhere: `STATS_JOINS` fans a split (§SPLIT) out into one row per
  // part, and "how many payments" is about operations, not parts.
  return await db.prepare(
    `SELECT ${spendSum(mult)} AS spent,
            COUNT(DISTINCT CASE WHEN ${DEBIT} THEN t.id END) AS spend_n,
            MIN(CASE WHEN ${DEBIT} THEN t.time END) AS spend_first,
            MAX(CASE WHEN ${DEBIT} THEN t.time END) AS spend_last,
            ${incomeSum(mult)} AS income,
            COUNT(DISTINCT CASE WHEN ${INCOME_WHERE} THEN t.id END) AS income_n,
            MIN(CASE WHEN ${INCOME_WHERE} THEN t.time END) AS income_first,
            MAX(CASE WHEN ${INCOME_WHERE} THEN t.time END) AS income_last,
            CAST(ROUND(COALESCE(SUM(CASE WHEN ${REFUND} THEN ${EFF_AMOUNT} * ${mult} ELSE 0 END), 0)) AS INTEGER) AS refunds,
            COUNT(DISTINCT CASE WHEN ${REFUND} THEN t.id END) AS refund_n,
            COUNT(DISTINCT CASE WHEN COALESCE((${SPEND_WHERE}), 0) = 0 AND COALESCE((${INCOME_WHERE}), 0) = 0 THEN t.id END) AS other_n,
            COUNT(DISTINCT t.id) AS total_n
     FROM transactions t ${STATS_JOINS} WHERE t.merchant = ?`,
  ).bind(name).first<MerchantAggregate>();
}

export async function merchantByMonth(
  db: AppDb, mult: string, now: number, name: string, from: number,
): Promise<{ m: string; spent: number; income: number }[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS m, ${spendSum(mult)} AS spent, ${incomeSum(mult)} AS income
     FROM transactions t ${STATS_JOINS} WHERE t.merchant = ? AND t.time >= ?
     GROUP BY m ORDER BY m`,
  ).bind(name, from).all<{ m: string; spent: number; income: number }>();
  return res.results ?? [];
}

export interface TopCategory {
  id: number | null; name: string | null; color: string | null; amount: number;
}

/** The category that carries most of this merchant's money on one side of the ledger. */
export async function merchantTopCategory(
  db: AppDb, locale: NotifLocale, mult: string, name: string, side: MerchantSideKey,
): Promise<TopCategory | null> {
  const where = side === "spend" ? SPEND_WHERE : INCOME_WHERE;
  const sum = side === "spend" ? spendSum(mult) : incomeSum(mult);
  return await db.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${catNameSql(locale, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color, ${sum} AS amount
     FROM transactions t ${STATS_JOINS} WHERE ${where} AND t.merchant = ?
     GROUP BY ${EFF_CAT_ID} ORDER BY amount DESC LIMIT 1`,
  ).bind(name).first<TopCategory>();
}

/** All-time money in one effective category on one side — the denominator for "share of category". */
export async function categoryTotalAllTime(
  db: AppDb, mult: string, categoryId: number, side: MerchantSideKey,
): Promise<{ amount: number } | null> {
  const where = side === "spend" ? SPEND_WHERE : INCOME_WHERE;
  const sum = side === "spend" ? spendSum(mult) : incomeSum(mult);
  return await db.prepare(
    `SELECT ${sum} AS amount FROM transactions t ${STATS_JOINS} WHERE ${where} AND ${EFF_CAT_ID} = ?`,
  ).bind(categoryId).first<{ amount: number }>();
}

/** Recent rows for the merchant. NOT filtered by either side — the list shows refunds and
 *  transfers too, because hiding them would make the history look wrong to the reader. One row
 *  per operation (`GROUP BY t.id`): the split fan-out of `STATS_JOINS` would list a split twice. */
export async function merchantTransactions(
  db: AppDb, locale: NotifLocale, name: string, limit: number,
): Promise<TxRow[]> {
  const res = await db.prepare(
    `SELECT t.*, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name, ${EFF_CAT_COLOR} AS category_color,
            COALESCE(rc.icon, c.icon) AS category_icon
     FROM transactions t ${STATS_JOINS} WHERE t.merchant = ? GROUP BY t.id ORDER BY t.time DESC LIMIT ?`,
  ).bind(name, limit).all<TxRow>();
  return res.results ?? [];
}

/** Operation times on one side, oldest first — the input for the cadence ("every ~30 days"). */
export async function merchantTimes(db: AppDb, name: string, side: MerchantSideKey): Promise<number[]> {
  const where = side === "spend" ? DEBIT : INCOME_WHERE;
  const res = await db.prepare(
    `SELECT DISTINCT t.id, t.time FROM transactions t ${STATS_JOINS} WHERE ${where} AND t.merchant = ? ORDER BY t.time`,
  ).bind(name).all<{ id: string; time: number }>();
  return (res.results ?? []).map((r) => r.time);
}
