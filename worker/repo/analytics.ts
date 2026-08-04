// Analytics reads. See `worker/repo/README.md`.
//
// These functions COMPOSE the canon from `lib/finance/stats.ts` (`STATS_JOINS`, `SPEND_WHERE`,
// `amountSum`, `EFF_*`); they never restate what those mean. That division is the whole point:
// the canon decides what "spending" is, this layer decides how to ask for it, and the route
// decides how to present the answer. §CUR-PLAN, §SUB-MONTH and §REFUND all happened because
// those three jobs were done in one place and the second copy drifted.
import type { AppDb } from "../lib/platform/db-shim.ts";
import {
  STATS_JOINS, SPEND_WHERE, SPEND_COUNT, INCOME_WHERE, EFF_AMOUNT, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR,
  EFF_IMPORTANCE, spendSum, incomeSum, amountSum, localYmSql,
} from "../lib/finance/stats.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";

/**
 * How amounts are valued, straight from `valueMode(rates, currency)`.
 *
 * `mult` is the inline ₴ conversion CASE; `curFilter` narrows to a single currency when the user
 * asked for "clean" figures instead of a hryvnia roll-up. They always travel together — passing
 * one without the other is how a screen ends up converting some rows and not others.
 */
export interface ValueScope {
  mult: string;
  curFilter: string;
}

export interface Range { from: number; to: number }

export interface PeriodTotals { spend: number; income: number; n: number }

/** Canonical spend/income/count for a window. */
export async function periodTotals(
  db: AppDb, v: ValueScope, r: Range,
): Promise<PeriodTotals | null> {
  return await db.prepare(
    `SELECT ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income, ${SPEND_COUNT} AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${v.curFilter}`,
  ).bind(r.from, r.to).first<PeriodTotals>();
}

/**
 * Spend/income bucketed for the chart.
 *
 * `fmt` is an `strftime` pattern chosen by the caller (day / week / month) and is interpolated,
 * not bound — SQLite will not take a format string as a parameter. It never comes from user
 * input: the route maps a fixed bucket name onto one of three literals.
 */
export async function series(
  db: AppDb, v: ValueScope, r: Range, fmt: string,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT strftime('${fmt}', t.time, 'unixepoch') AS bucket,
            ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${v.curFilter}
     GROUP BY bucket ORDER BY bucket`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}

/** Breakdown by EFFECTIVE category — cash and withdrawals by what they were really for, rolled
 *  up into the parent. */
export async function spendByCategory(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name,
            ${EFF_CAT_COLOR} AS color, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}

export async function spendByMerchant(
  db: AppDb, v: ValueScope, r: Range,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT t.merchant AS merchant, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter} AND t.merchant IS NOT NULL
     GROUP BY t.merchant ORDER BY spent DESC LIMIT 10`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}

export async function spendByAccount(
  db: AppDb, v: ValueScope, r: Range,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT t.account_id, a.title AS account_title, a.type AS account_type, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS} LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY t.account_id ORDER BY spent DESC`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}

/**
 * Spend per event group.
 *
 * Deliberately NOT `SPEND_WHERE`: a trip or a party legitimately contains transfers, so the
 * filter here is the looser "negative and not a transfer". Converted to ₴ either way.
 */
export async function spendByEvent(
  db: AppDb, v: ValueScope, r: Range,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT e.id AS event_id, e.name AS event_name, e.color AS event_color,
            ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS} JOIN event_groups e ON e.id = t.event_id
     WHERE t.time >= ? AND t.time <= ? AND ${EFF_AMOUNT} < 0 AND t.is_transfer = 0${v.curFilter}
     GROUP BY t.event_id ORDER BY spent DESC`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}

// ---- totals without a count -------------------------------------------------
//
// ⚠️ The two functions below are near-duplicates of `periodTotals` and `spendByCategory`: they
// differ only by NOT selecting the transaction count. They are kept separate on purpose during
// this refactor, which is strictly behaviour-preserving — an extra column in a response is a
// behaviour change. Merging them is a phase-4 candidate, and having them side by side here is
// what makes that visible; inline in two handlers, nobody could see they were almost the same.

/**
 * Canonical spend + income for a window.
 *
 * Shared by period comparison and the month-end forecast: with an empty `curFilter` the two
 * handlers were already issuing a byte-identical query, they just could not see each other.
 */
export async function spendIncomeTotals(
  db: AppDb, v: ValueScope, r: Range,
): Promise<{ spend: number; income: number } | null> {
  return await db.prepare(
    `SELECT ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${v.curFilter}`,
  ).bind(r.from, r.to).first<{ spend: number; income: number }>();
}

export async function compareByCategory(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name, ${EFF_CAT_COLOR} AS color,
            ${amountSum(v.mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}

// ---- single merchant --------------------------------------------------------

export interface MerchantAggregate {
  total: number; n: number; first_at: number | null; last_at: number | null;
}

export async function merchantAggregate(
  db: AppDb, mult: string, name: string,
): Promise<MerchantAggregate | null> {
  return await db.prepare(
    `SELECT ${amountSum(mult)} AS total, COUNT(DISTINCT t.id) AS n, MIN(t.time) AS first_at, MAX(t.time) AS last_at
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND t.merchant = ?`,
  ).bind(name).first<MerchantAggregate>();
}

export async function merchantByMonth(
  db: AppDb, mult: string, now: number, name: string, from: number,
): Promise<{ m: string; spent: number }[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS m, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND t.merchant = ? AND t.time >= ?
     GROUP BY m ORDER BY m`,
  ).bind(name, from).all<{ m: string; spent: number }>();
  return res.results ?? [];
}

export interface TopCategory {
  id: number | null; name: string | null; color: string | null; spent: number;
}

export async function merchantTopCategory(
  db: AppDb, locale: NotifLocale, mult: string, name: string,
): Promise<TopCategory | null> {
  return await db.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${catNameSql(locale, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND t.merchant = ?
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 1`,
  ).bind(name).first<TopCategory>();
}

/** Recent rows for the merchant. NOT filtered by `SPEND_WHERE` — the detail list shows refunds
 *  and transfers too, because hiding them would make the history look wrong to the reader. */
export async function merchantTransactions(
  db: AppDb, locale: NotifLocale, name: string,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT t.*, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name, ${EFF_CAT_COLOR} AS category_color,
            COALESCE(rc.icon, c.icon) AS category_icon
     FROM transactions t ${STATS_JOINS} WHERE t.merchant = ? ORDER BY t.time DESC LIMIT 40`,
  ).bind(name).all();
  return res.results ?? [];
}

/** All-time spending in one effective category — the denominator for "share of category". */
export async function categoryTotalAllTime(
  db: AppDb, mult: string, categoryId: number,
): Promise<{ spent: number } | null> {
  return await db.prepare(
    `SELECT ${amountSum(mult)} AS spent FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND ${EFF_CAT_ID} = ?`,
  ).bind(categoryId).first<{ spent: number }>();
}

/**
 * Spend per calendar month over a half-open window `[from, to)`.
 *
 * The exclusive upper bound is the point: this is the forecast's trailing anchor, and it must
 * cover only COMPLETE months. Including the current partial month would drag the historical
 * average down and make every projection read low early in the month.
 */
export async function monthlySpendBefore(
  db: AppDb, mult: string, now: number, from: number, to: number,
): Promise<{ m: string; spend: number }[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS m, ${spendSum(mult)} AS spend
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? GROUP BY m`,
  ).bind(from, to).all<{ m: string; spend: number }>();
  return res.results ?? [];
}

// ---- sparkline series --------------------------------------------------------

/** Spend per effective category per month — one sparkline row per category. */
export async function categoryMonthSeries(
  db: AppDb, mult: string, now: number, from: number,
): Promise<{ id: number; m: string; spent: number }[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${localYmSql(now)} AS m, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}, m`,
  ).bind(from).all<{ id: number; m: string; spent: number }>();
  return res.results ?? [];
}

/** Spend per merchant per month — the same, keyed by merchant name. */
export async function merchantMonthSeries(
  db: AppDb, mult: string, now: number, from: number,
): Promise<{ name: string; m: string; spent: number }[]> {
  const res = await db.prepare(
    `SELECT t.merchant AS name, ${localYmSql(now)} AS m, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL GROUP BY t.merchant, m`,
  ).bind(from).all<{ name: string; m: string; spent: number }>();
  return res.results ?? [];
}

/** Currencies that actually appear in the ledger — drives the currency switcher. */
export async function distinctCurrencies(db: AppDb): Promise<number[]> {
  const res = await db.prepare(
    "SELECT DISTINCT currency_code FROM transactions ORDER BY currency_code",
  ).all<{ currency_code: number }>();
  return (res.results ?? []).map((r) => r.currency_code);
}

// ---- income ------------------------------------------------------------------

export interface IncomeSource {
  category_id: number | null; name: string | null; color: string | null; amount: number; n: number;
}

/**
 * Income broken down by effective category.
 *
 * ⚠️ **Known defect, preserved deliberately.** The sum here is `SUM(t.amount)`, NOT the canonical
 * `incomeSum` — so it does not subtract `reimburses_total` (§COMPENSATION) the way the period
 * total does. An incoming transfer that was partly allocated to expenses therefore appears in
 * full in its category row but only as its remainder in the total, and the percentages can add
 * up to more than 100%. Reproduced by the golden fixture: total 47 700 ₴ against 48 700 ₴ of
 * sources, 102%.
 *
 * It is carried over unchanged because this refactor is behaviour-preserving; the fix (use
 * `incomeSum(mult)` and re-record the goldens) is its own card in `ROADMAP.md`. This comment
 * exists so the next reader does not "tidy" it into a silent behaviour change.
 */
export async function incomeBySource(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<IncomeSource[]> {
  const rawIncomeSum = `CAST(ROUND(COALESCE(SUM(t.amount * ${v.mult}), 0)) AS INTEGER)`;
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(locale, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color,
            ${rawIncomeSum} AS amount, COUNT(*) AS n
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

export interface MonthRow { month: string; spend: number; income: number }

/**
 * Spend/income grouped by calendar month, from `from` onwards.
 *
 * Months with no transactions are simply absent — the caller fills the gaps, because only it
 * knows how many months the axis should span. The `%Y-%m` grouping is LOCAL (`localYmSql`), not
 * UTC: the JS side builds month keys locally too, and a mismatch reads as a ZERO month rather
 * than an error, quietly understating the level of a category.
 */
export async function monthlyHistory(
  db: AppDb, v: Pick<ValueScope, "mult">, now: number, from: number,
): Promise<MonthRow[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS month,
            ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ?
     GROUP BY month ORDER BY month`,
  ).bind(from).all<MonthRow>();
  return res.results ?? [];
}

export interface MonthToDate { spend: number; income: number; essential: number }

/** §4 — month-to-date totals with the essential share broken out (§6). */
export async function monthToDate(
  db: AppDb, v: Pick<ValueScope, "mult">, r: Range,
): Promise<MonthToDate | null> {
  return await db.prepare(
    `SELECT ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income,
            CAST(ROUND(COALESCE(SUM(CASE WHEN ${SPEND_WHERE} AND ${EFF_IMPORTANCE} = 'essential' THEN (-${EFF_AMOUNT}) * ${v.mult} ELSE 0 END), 0)) AS INTEGER) AS essential
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?`,
  ).bind(r.from, r.to).first<MonthToDate>();
}

/**
 * Net capital change per day, in ₴ minor units, sign preserved.
 *
 * Deliberately NOT canonical spending: this reconstructs BALANCE, so every row counts, including
 * transfers (both legs are present and cancel each other out). Applying `SPEND_WHERE` here would
 * silently drop the transfer legs and bend the curve.
 */
export async function dailyNetChange(
  db: AppDb, mult: string, from: number,
): Promise<{ day: number; net: number }[]> {
  const res = await db.prepare(
    `SELECT CAST(t.time / 86400 AS INTEGER) AS day,
            CAST(ROUND(COALESCE(SUM(t.amount * ${mult}), 0)) AS INTEGER) AS net
     FROM transactions t WHERE t.time >= ? GROUP BY day`,
  ).bind(from).all<{ day: number; net: number }>();
  return res.results ?? [];
}

/**
 * Net change per account per day, in each ACCOUNT's own currency.
 *
 * Conversion is left to the caller because net-worth history values each point at the rate of
 * ITS OWN date (§rate history) — converting here would flatten every past month onto today's
 * rate, which is the bug that motivated storing rate history in the first place.
 */
export async function dailyNetChangeByAccount(
  db: AppDb, from: number,
): Promise<{ acc: string; day: number; net: number }[]> {
  const res = await db.prepare(
    `SELECT t.account_id AS acc, CAST(t.time / 86400 AS INTEGER) AS day,
            CAST(COALESCE(SUM(t.amount), 0) AS INTEGER) AS net
     FROM transactions t WHERE t.time >= ? GROUP BY t.account_id, day`,
  ).bind(from).all<{ acc: string; day: number; net: number }>();
  return res.results ?? [];
}

/** §6 — the essential / discretionary / optional split. */
export async function spendByImportance(
  db: AppDb, v: ValueScope, r: Range,
): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(
    `SELECT ${EFF_IMPORTANCE} AS importance, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY ${EFF_IMPORTANCE}`,
  ).bind(r.from, r.to).all();
  return res.results ?? [];
}
