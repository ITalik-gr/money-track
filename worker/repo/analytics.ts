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
import { localDowSql, type WeekdayRow } from "../lib/finance/weekday.ts";
import type { MerchantMonthRow } from "../lib/finance/habits.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import { stLit } from "../lib/platform/i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
// The repo returns the CONTRACT types where a query maps one-to-one onto a response shape.
// Declaring a private twin here would re-create D2 one layer down: two spellings of one row,
// drifting quietly, with `tsc` unable to compare them.
import type { CategorySpend, DrillTx, PeriodTotals } from "../../shared/api/analytics.ts";
import type { TxRow } from "../../shared/api/transactions.ts";

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

/**
 * Canonical spend/income/count for a window.
 *
 * Two things about the return type are load-bearing:
 *
 * 1. It is NOT nullable. An aggregate with no GROUP BY always yields exactly one row in SQLite,
 *    even over an empty table — `.first()` types itself as `T | null` in general, but cannot be
 *    null here. Proved on the wire by `__golden__/empty/analytics.overview.json`, which shows an
 *    object rather than a null.
 * 2. `n` IS nullable, and that is a defect the contract has to be honest about: `SUM()` over an
 *    empty set is NULL, and `SPEND_COUNT` — unlike `spendSum`/`incomeSum` — carries no
 *    `COALESCE`. So a brand-new account reads `n: null` where the UI expects a number. Card in
 *    ROADMAP.md; not fixed here, because this pass is behaviour-preserving.
 */
export async function periodTotals(
  db: AppDb, v: ValueScope, r: Range,
): Promise<PeriodTotals> {
  return (await db.prepare(
    `SELECT ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income, ${SPEND_COUNT} AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${v.curFilter}`,
  ).bind(r.from, r.to).first<PeriodTotals>())!;
}

/**
 * Spend/income bucketed for the chart.
 *
 * `fmt` is an `strftime` pattern chosen by the caller (day / week / month) and is interpolated,
 * not bound — SQLite will not take a format string as a parameter. It never comes from user
 * input: the route maps a fixed bucket name onto one of three literals.
 */
export type SeriesPoint = { bucket: string; spend: number; income: number };

export async function series(
  db: AppDb, v: ValueScope, r: Range, fmt: string,
): Promise<SeriesPoint[]> {
  const res = await db.prepare(
    `SELECT strftime('${fmt}', t.time, 'unixepoch') AS bucket,
            ${spendSum(v.mult)} AS spend, ${incomeSum(v.mult)} AS income
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${v.curFilter}
     GROUP BY bucket ORDER BY bucket`,
  ).bind(r.from, r.to).all<SeriesPoint>();
  return res.results ?? [];
}

/** Breakdown by EFFECTIVE category — cash and withdrawals by what they were really for, rolled
 *  up into the parent. */
export async function spendByCategory(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<CategorySpend[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name,
            ${EFF_CAT_COLOR} AS color, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
  ).bind(r.from, r.to).all<CategorySpend>();
  return res.results ?? [];
}

export type MerchantSpend = { merchant: string; spent: number; n: number };

export async function spendByMerchant(
  db: AppDb, v: ValueScope, r: Range,
): Promise<MerchantSpend[]> {
  const res = await db.prepare(
    `SELECT t.merchant AS merchant, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter} AND t.merchant IS NOT NULL
     GROUP BY t.merchant ORDER BY spent DESC LIMIT 10`,
  ).bind(r.from, r.to).all<MerchantSpend>();
  return res.results ?? [];
}

export type AccountSpend = { account_id: string | null; account_title: string | null; account_type: string | null; spent: number; n: number };

export async function spendByAccount(
  db: AppDb, v: ValueScope, r: Range,
): Promise<AccountSpend[]> {
  const res = await db.prepare(
    `SELECT t.account_id, a.title AS account_title, a.type AS account_type, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS} LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY t.account_id ORDER BY spent DESC`,
  ).bind(r.from, r.to).all<AccountSpend>();
  return res.results ?? [];
}

/**
 * Spend per event group.
 *
 * Deliberately NOT `SPEND_WHERE`: a trip or a party legitimately contains transfers, so the
 * filter here is the looser "negative and not a transfer". Converted to ₴ either way.
 */
export type EventSpend = { event_id: number; event_name: string; event_color: string | null; spent: number; n: number };

export async function spendByEvent(
  db: AppDb, v: ValueScope, r: Range,
): Promise<EventSpend[]> {
  const res = await db.prepare(
    `SELECT e.id AS event_id, e.name AS event_name, e.color AS event_color,
            ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS} JOIN event_groups e ON e.id = t.event_id
     WHERE t.time >= ? AND t.time <= ? AND ${EFF_AMOUNT} < 0 AND t.is_transfer = 0${v.curFilter}
     GROUP BY t.event_id ORDER BY spent DESC`,
  ).bind(r.from, r.to).all<EventSpend>();
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

/** Same rows as `spendByCategory` minus the count — see the note above about why both exist. */
export type CategorySpendNoCount = Omit<CategorySpend, "n">;

export async function compareByCategory(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<CategorySpendNoCount[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name, ${EFF_CAT_COLOR} AS color,
            ${amountSum(v.mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
  ).bind(r.from, r.to).all<CategorySpendNoCount>();
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
): Promise<TxRow[]> {
  const res = await db.prepare(
    `SELECT t.*, ${catNameSql(locale, EFF_CAT_NAME)} AS category_name, ${EFF_CAT_COLOR} AS category_color,
            COALESCE(rc.icon, c.icon) AS category_icon
     FROM transactions t ${STATS_JOINS} WHERE t.merchant = ? ORDER BY t.time DESC LIMIT 40`,
  ).bind(name).all<TxRow>();
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
            ${incomeSum(v.mult)} AS amount, COUNT(*) AS n
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
export type ImportanceSpend = { importance: string; spent: number; n: number };

export async function spendByImportance(
  db: AppDb, v: ValueScope, r: Range,
): Promise<ImportanceSpend[]> {
  const res = await db.prepare(
    `SELECT ${EFF_IMPORTANCE} AS importance, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY ${EFF_IMPORTANCE}`,
  ).bind(r.from, r.to).all<ImportanceSpend>();
  return res.results ?? [];
}

/**
 * §WEEKDAY — canonical spend grouped by LOCAL day of week.
 *
 * `localDowSql` rather than a bare `strftime('%w')`: the app's day runs on Europe/Kyiv, so in UTC
 * every purchase after 21:00 lands on the next weekday — and Friday evening is the densest spend
 * window there is. The bug would not look like a bug; it would look like Saturday being expensive.
 */
export async function spendByWeekday(
  db: AppDb, v: ValueScope, r: Range, now: number,
): Promise<WeekdayRow[]> {
  const res = await db.prepare(
    `SELECT ${localDowSql(now)} AS dow, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n,
            CAST(ROUND(COALESCE(MAX((-${EFF_AMOUNT}) * ${v.mult}), 0)) AS INTEGER) AS biggest
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
     GROUP BY dow ORDER BY dow`,
  ).bind(r.from, r.to).all<WeekdayRow>();
  return res.results ?? [];
}

/**
 * §HABITS — spend per merchant per calendar month, for the habit diff.
 *
 * Grouped in SQL but classified in JS (`lib/finance/habits.ts`): the thresholds are a judgement
 * about what counts as a habit, and judgements belong where they can be read, not inside a
 * string the type system cannot see into.
 */
export async function merchantMonths(
  db: AppDb, v: ValueScope, r: Range, now: number,
): Promise<MerchantMonthRow[]> {
  const res = await db.prepare(
    `SELECT t.merchant AS merchant, ${localYmSql(now)} AS ym,
            ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${v.curFilter}
       AND t.merchant IS NOT NULL AND t.merchant <> ''
     GROUP BY t.merchant, ym HAVING spent > 0`,
  ).bind(r.from, r.to).all<MerchantMonthRow>();
  return res.results ?? [];
}

// ---- patterns (§E1/E2/E3) ----------------------------------------------------

export interface CategoryMonthCell {
  id: number | null; name: string | null; color: string | null; m: string; spent: number;
}

/**
 * Spend per effective category per calendar month — the trailing matrix behind the anomaly radar.
 *
 * Month keys come from `localYmSql(now)`, not from a UTC `strftime`, and that matters more here
 * than anywhere else: the caller builds the list of month keys in JS while SQL builds the row
 * keys, so a timezone mismatch between the two does not raise an error — it silently reads as a
 * ZERO month and drags the category's level down (§APP_TZ).
 */
export async function categoryMonthMatrix(
  db: AppDb, locale: NotifLocale, mult: string, now: number, r: Range,
): Promise<CategoryMonthCell[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${catNameSql(locale, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color,
            ${localYmSql(now)} AS m, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}, m`,
  ).bind(r.from, r.to).all<CategoryMonthCell>();
  return res.results ?? [];
}

export interface MonthCategorySplit {
  id: number | null; recurring: number; oneoff: number; n: number; biggest: number;
}

/**
 * The current month per category, split into recurring and one-off, plus the two lumpiness
 * signals the projection needs: `n` (how many operations) and `biggest` (the largest single one).
 *
 * `recurringExpr` is `isRecurringExpr(...)` from the canon, passed in rather than rebuilt here —
 * "is this spending regular" is the canon's definition to make, and restating it locally is
 * exactly the move that produced §CUR-PLAN.
 *
 * `COUNT(DISTINCT t.id)`, never `COUNT(*)`: `STATS_JOINS` multiplies a split transaction into one
 * row per part, so `COUNT(*)` would overstate the count and understate the average cheque (§SPLIT).
 */
export async function currentMonthSplitByCategory(
  db: AppDb, mult: string, recurringExpr: string, r: Range,
): Promise<MonthCategorySplit[]> {
  const res = await db.prepare(
    `SELECT ${EFF_CAT_ID} AS id,
            CAST(ROUND(COALESCE(SUM(CASE WHEN ${recurringExpr} THEN (-${EFF_AMOUNT}) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS recurring,
            CAST(ROUND(COALESCE(SUM(CASE WHEN ${recurringExpr} THEN 0 ELSE (-${EFF_AMOUNT}) * ${mult} END), 0)) AS INTEGER) AS oneoff,
            COUNT(DISTINCT t.id) AS n,
            CAST(ROUND(COALESCE(MAX((-${EFF_AMOUNT}) * ${mult}), 0)) AS INTEGER) AS biggest
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}`,
  ).bind(r.from, r.to).all<MonthCategorySplit>();
  return res.results ?? [];
}

// ---- one-category drill-down (§F5) -------------------------------------------

/** Bucket 13, "Transfers and withdrawals" — the one category that is NOT canonical spending. */
const TRANSFER_BUCKET = 13;

/**
 * The filter for the transfer bucket, shared by its three queries.
 *
 * Deliberately NOT `SPEND_WHERE`: this bucket is what the canon *excludes*, so asking for it with
 * the spending filter would return nothing. It is informational — unresolved cash movements plus
 * genuine transfers — and it is grouped by what the money was really for (`real_category_id`).
 */
function transferBucketWhere(v: ValueScope): string {
  return `t.time >= ? AND t.time <= ? AND t.amount < 0 AND t.hold = 0 AND COALESCE(c.parent_id, t.category_id) = ${TRANSFER_BUCKET}` + v.curFilter;
}

/** A drill-down sub-row: the leaf category inside the requested parent (or inside bucket 13). */
export type DrillSub = { category_id: number | null; name: string; color: string | null; spent: number; n: number };

export async function transferBucketSubs(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<DrillSub[]> {
  const res = await db.prepare(
    `SELECT t.real_category_id AS category_id, COALESCE(${catNameSql(locale, "rc.name")}, ${stLit(locale, "unidentified")}) AS name, rc.color AS color,
            ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE ${transferBucketWhere(v)} GROUP BY t.real_category_id ORDER BY spent DESC`,
  ).bind(r.from, r.to).all<DrillSub>();
  return res.results ?? [];
}

export async function transferBucketMerchants(
  db: AppDb, v: ValueScope, r: Range,
): Promise<MerchantSpend[]> {
  const res = await db.prepare(
    `SELECT t.merchant AS merchant, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE ${transferBucketWhere(v)} AND t.merchant IS NOT NULL AND t.merchant <> '' GROUP BY t.merchant ORDER BY spent DESC LIMIT 12`,
  ).bind(r.from, r.to).all<MerchantSpend>();
  return res.results ?? [];
}

/**
 * The bucket's own transactions.
 *
 * ⚠️ Joins `categories` by hand instead of using `STATS_JOINS`, and that is intentional, not an
 * oversight: this query selects raw `t.amount` and never touches `sp.*`, so the split join would
 * duplicate rows in a plain list for no benefit. The `c` alias is still needed — the filter reads
 * `COALESCE(c.parent_id, t.category_id)`.
 */
export async function transferBucketTransactions(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range,
): Promise<DrillTx[]> {
  const res = await db.prepare(
    `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment,
            ${catNameSql(locale, "rc.name")} AS category_name, rc.color AS category_color
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                          LEFT JOIN categories rc ON rc.id = t.real_category_id
     WHERE ${transferBucketWhere(v)} ORDER BY t.amount ASC LIMIT 60`,
  ).bind(r.from, r.to).all<DrillTx>();
  return res.results ?? [];
}

/**
 * The filter for an ordinary category: canonical spending whose EFFECTIVE (rolled-up) category is
 * the requested parent. The breakdown below then splits it by the actual leaf category — the real
 * one for cash, the plain one otherwise.
 */
function categoryDrillWhere(v: ValueScope): string {
  return `t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND ${EFF_CAT_ID} = ?${v.curFilter}`;
}

export async function categorySubs(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range, parent: number,
): Promise<DrillSub[]> {
  const res = await db.prepare(
    `SELECT COALESCE(rc.id, c.id) AS category_id,
            COALESCE(${catNameSql(locale, "COALESCE(rc.name, c.name)")}, ${stLit(locale, "uncategorized")}) AS name,
            COALESCE(rc.color, c.color) AS color, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE ${categoryDrillWhere(v)} GROUP BY COALESCE(rc.id, c.id) ORDER BY spent DESC`,
  ).bind(r.from, r.to, parent).all<DrillSub>();
  return res.results ?? [];
}

export async function categoryMerchants(
  db: AppDb, v: ValueScope, r: Range, parent: number,
): Promise<MerchantSpend[]> {
  const res = await db.prepare(
    `SELECT t.merchant AS merchant, ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE ${categoryDrillWhere(v)} AND t.merchant IS NOT NULL AND t.merchant <> '' GROUP BY t.merchant ORDER BY spent DESC LIMIT 12`,
  ).bind(r.from, r.to, parent).all<MerchantSpend>();
  return res.results ?? [];
}

export async function categoryTransactions(
  db: AppDb, v: ValueScope, r: Range, parent: number,
): Promise<DrillTx[]> {
  const res = await db.prepare(
    `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment,
            COALESCE(rc.name, c.name) AS category_name, COALESCE(rc.color, c.color) AS category_color
     FROM transactions t ${STATS_JOINS}
     WHERE ${categoryDrillWhere(v)} ORDER BY t.amount ASC LIMIT 60`,
  ).bind(r.from, r.to, parent).all<DrillTx>();
  return res.results ?? [];
}

// ---- arbitrary slice drill (§R2-ST5б) ----------------------------------------

export interface SliceQuery {
  /** merchant | account | event | weekday | day | dom | importance | all */
  dim: string;
  type: "expense" | "income";
  /** The dimension's value; ignored when `dim` is "all". */
  value: string;
  limit: number;
}

/**
 * Resolves a slice request into a WHERE clause and its bindings.
 *
 * The dimension is mapped onto a FIXED set of SQL expressions — user input picks which literal,
 * it never reaches the query as text. The value itself is always bound.
 *
 * The type filter is the canon (`SPEND_WHERE` / `INCOME_WHERE`) rather than a local `amount < 0`,
 * so a drill-down always reconciles with the KPI on the Overview screen it was opened from.
 */
function sliceParts(v: ValueScope, r: Range, q: SliceQuery): { base: string; binds: unknown[] } {
  const canon = q.type === "income" ? INCOME_WHERE : SPEND_WHERE;
  // §E1: weekday — 0=Sun..6=Sat. day — one calendar date (the same UTC bucket `series` grouped
  // by). dom — day of month, for the heat-map. all — the whole period, for drilling the
  // "Spending / Income" KPI itself.
  const dimCol = q.dim === "account" ? "t.account_id"
    : q.dim === "event" ? "t.event_id"
    : q.dim === "weekday" ? "CAST(strftime('%w', t.time, 'unixepoch') AS INTEGER)"
    : q.dim === "day" ? "strftime('%Y-%m-%d', t.time, 'unixepoch')"
    : q.dim === "dom" ? "CAST(strftime('%d', t.time, 'unixepoch') AS INTEGER)"
    : q.dim === "importance" ? EFF_IMPORTANCE
    : q.dim === "all" ? null
    : "t.merchant";
  const dimClause = dimCol ? ` AND ${dimCol} = ?` : "";
  // The numeric dimensions are compared against INTEGER columns/expressions, so the value is
  // coerced here rather than bound as the string it arrived as.
  const numeric = q.dim === "event" || q.dim === "weekday" || q.dim === "dom";
  const binds: unknown[] = dimCol
    ? [r.from, r.to, numeric ? Number(q.value) : q.value]
    : [r.from, r.to];
  return { base: `t.time >= ? AND t.time <= ? AND ${canon}${v.curFilter}${dimClause}`, binds };
}

/** Slice total. NOTE: `amountSum` counts `-amount`, so income comes back negative — the caller
 *  takes the absolute value. */
export async function sliceSummary(
  db: AppDb, v: ValueScope, r: Range, q: SliceQuery,
): Promise<{ spent: number; n: number } | null> {
  const { base, binds } = sliceParts(v, r, q);
  return await db.prepare(
    `SELECT ${amountSum(v.mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS} WHERE ${base}`,
  ).bind(...binds).first<{ spent: number; n: number }>();
}

/** The slice's transactions: biggest expense / biggest income first. */
export async function sliceTransactions(
  db: AppDb, locale: NotifLocale, v: ValueScope, r: Range, q: SliceQuery,
): Promise<DrillTx[]> {
  const { base, binds } = sliceParts(v, r, q);
  const order = q.type === "income" ? "DESC" : "ASC";
  const res = await db.prepare(
    `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment, t.user_note,
            ${catNameSql(locale, EFF_CAT_NAME)} AS category_name, ${EFF_CAT_COLOR} AS category_color
     FROM transactions t ${STATS_JOINS}
     WHERE ${base} ORDER BY t.amount ${order} LIMIT ?`,
  ).bind(...binds, q.limit).all<DrillTx>();
  return res.results ?? [];
}

// ---- health index (§H) -------------------------------------------------------

/**
 * Records today's health score, one row per day.
 *
 * §APP_TZ: `day` MUST be a Kyiv-local key. The notification feed's `draftHealthDrop` compares
 * these rows to spot a decline "over 5 days", so a UTC key would put an evening view and a
 * late-night view of the same day into two different rows and measure the drop on a shifted grid.
 */
export async function recordHealthScore(
  db: AppDb, day: string, score: number, ts: number,
): Promise<void> {
  await db.prepare(
    "INSERT INTO health_history (day, score, ts) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET score = excluded.score, ts = excluded.ts",
  ).bind(day, score, ts).run();
}

export async function healthTrend(
  db: AppDb, since: string,
): Promise<{ day: string; score: number }[]> {
  const res = await db.prepare(
    "SELECT day, score FROM health_history WHERE day >= ? ORDER BY day",
  ).bind(since).all<{ day: string; score: number }>();
  return res.results ?? [];
}

/**
 * §IMPORTANCE-TREND — the monthly split into essential / discretionary / optional.
 *
 * The period breakdown on the Stats overview answers "what share of THIS month was optional". It
 * cannot answer the question that matters more: whether the optional share is CLIMBING. A total
 * that grows tells you nothing on its own — a bigger essential bill and a bigger optional habit
 * look identical in it, and only one of them is a decision you can revisit.
 *
 * Canon throughout (`SPEND_WHERE` + `amountSum` + `EFF_IMPORTANCE`), and the month key is
 * `localYmSql` for the same reason as everywhere else: keys are built in JS by the caller, and a
 * month grouped in UTC misses the key silently and reads as a ZERO month (§APP_TZ).
 */
export async function importanceByMonth(
  db: AppDb, v: Pick<ValueScope, "mult">, now: number, from: number,
): Promise<{ month: string; importance: string; spent: number }[]> {
  const res = await db.prepare(
    `SELECT ${localYmSql(now)} AS month, ${EFF_IMPORTANCE} AS importance, ${amountSum(v.mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND ${SPEND_WHERE}
     -- GROUP BY the EXPRESSION, not the alias: the joined \`categories\` rows carry their own
     -- \`importance\` column, so the bare name is ambiguous and SQLite refuses the statement.
     GROUP BY month, ${EFF_IMPORTANCE} ORDER BY month`,
  ).bind(from).all<{ month: string; importance: string; spent: number }>();
  return res.results ?? [];
}
