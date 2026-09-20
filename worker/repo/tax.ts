/**
 * §TAX-BASE — the ONLY place that asks the database what business income is (лінт C1).
 *
 * Two rules meet here and neither is allowed to be restated elsewhere:
 *
 *  1. WHAT COUNTS AS INCOME is `INCOME_WHERE`, the canon from `stats.ts`, reused verbatim. A
 *     second definition would let the tax screen and the income screen disagree about the same
 *     money — and the one people would believe is whichever they opened last.
 *  2. WHAT IT IS WORTH is NOT the canon. Everywhere else an amount is rolled up into the reader's
 *     base currency (§BASE-CUR); tax is levied in hryvnia whatever the app is displaying, from a
 *     base frozen on the day the money arrived (§TAX-FX, §TAX-UAH).
 *
 * The filter is reused through `t.id IN (SELECT …)` rather than by repeating the joins: STATS_JOINS
 * includes `tx_splits`, which multiplies a split row, and a SUM over the multiplied rows would
 * quietly double that income. `IN` de-duplicates by construction, so the canon arrives unedited.
 */
import type { AppDb } from "../lib/platform/db-shim.ts";
import { STATS_JOINS, INCOME_WHERE, SPEND_WHERE } from "../lib/finance/stats.ts";
import { localFmtSql } from "../lib/finance/time.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";

/** The hryvnia base of one row: the frozen figure for foreign currency, the amount itself for ₴. */
const TAX_BASE = "CASE WHEN t.currency_code = 980 THEN t.amount ELSE t.tax_base_uah END";

/** §TAX-BASE: NULL on the transaction means «nobody was asked», so the account answers. */
const IS_BUSINESS = "COALESCE(t.is_business, a.is_business, 0)";

/**
 * The canon, as an `IN` set — optionally bounded by the SAME window as the outer query.
 *
 * ⚠️ WHY THE WINDOW IS REPEATED INSIDE. Without it the subquery evaluates the canon over the WHOLE
 * transactions table on every call, and the outer `t.time` bound then throws most of it away.
 * `businessOverview` asks six quarters × three aggregates, so one page open paid for eighteen
 * full-ledger passes: 26 ms per quarter at 20 000 rows, 129 ms for the default view and 250 ms for
 * the twelve quarters the endpoint allows. Repeating the bound halves each aggregate (measured:
 * 110 ms → 53 ms over six calls) and cannot change the answer — the outer query already discards
 * every row outside the window, so narrowing the set can only remove ids that were being filtered
 * anyway. The `IN` shape itself stays, and stays for its original reason: STATS_JOINS multiplies a
 * split row, and a SUM over the multiplied rows would double that money.
 *
 * ⚠️ Two placeholders, and they come FIRST: parameters bind in the order they appear in the SQL
 * text, and the `IN` sits in the WHERE ahead of the outer bound. Every windowed caller here binds
 * `(from, to, from, to)`.
 */
const canonIncome = (windowed = true) =>
  `t.id IN (SELECT t.id FROM transactions t ${STATS_JOINS} WHERE ${INCOME_WHERE}${
    windowed ? " AND t.time >= ? AND t.time < ?" : ""})`;

export interface BusinessIncome {
  /** ₴ minor units. */
  base_uah: number;
  /** How many receipts made it up. */
  n: number;
  /**
   * Foreign-currency receipts with no official rate stored yet.
   *
   * Reported rather than silently skipped or silently guessed: an income total that is quietly
   * missing a $2 000 invoice reads as «you are well under the limit», which is the one wrong
   * answer with a penalty attached. The screen says «3 receipts have no rate yet» instead.
   */
  missing_rate: number;
}

export async function businessIncome(
  db: AppDb, fromUnix: number, toUnix: number,
): Promise<BusinessIncome> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(COALESCE(${TAX_BASE}, 0)), 0) AS base_uah,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN t.currency_code != 980 AND t.tax_base_uah IS NULL THEN 1 ELSE 0 END), 0) AS missing_rate
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${canonIncome()} AND ${IS_BUSINESS} = 1
       AND t.time >= ? AND t.time < ?`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix).first<BusinessIncome>();
  return row ?? { base_uah: 0, n: 0, missing_rate: 0 };
}

export interface LedgerRow {
  id: string;
  time: number;
  merchant: string | null;
  amount: number;
  currency_code: number;
  tax_base_uah: number | null;
  rate: number | null;
  effective_date: string | null;
}

/**
 * The income ledger, one row per receipt — the shape a ФОП's book of income wants, and the input
 * to the accountant export. Joined to `nbu_rates` so the rate that produced the base travels with
 * it: a base figure whose rate has to be looked up separately is a figure nobody can check.
 */
export async function incomeLedger(
  db: AppDb, fromUnix: number, toUnix: number, now: number,
): Promise<LedgerRow[]> {
  // §APP_TZ: the row's DATE is a Kyiv date, so the join key goes through `localFmtSql` like every
  // other bucket in this project. A raw `date(t.time,'unixepoch')` would be UTC, and every receipt
  // that landed after 21:00 Kyiv would look up the NEXT day's official rate — a real rate, for the
  // wrong day, which is the kind of wrong that survives review.
  const res = await db.prepare(
    `SELECT t.id, t.time, t.merchant, t.amount, t.currency_code, t.tax_base_uah,
            r.rate AS rate, r.effective_date AS effective_date
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN nbu_rates r
            ON r.currency_code = t.currency_code
           AND r.fetched_for = ${localFmtSql(now, "%Y-%m-%d")}
     WHERE ${canonIncome()} AND ${IS_BUSINESS} = 1
       AND t.time >= ? AND t.time < ?
     ORDER BY t.time`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix).all<LedgerRow>();
  return res.results ?? [];
}

/** Foreign-currency business receipts still missing a frozen base — the backfill worklist. */
export async function receiptsWithoutBase(db: AppDb, limit = 50): Promise<
  { id: string; time: number; amount: number; currency_code: number }[]
> {
  const res = await db.prepare(
    `SELECT t.id, t.time, t.amount, t.currency_code
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${canonIncome(false)} AND ${IS_BUSINESS} = 1
       AND t.currency_code != 980 AND t.tax_base_uah IS NULL
     ORDER BY t.time DESC LIMIT ?`,
  ).bind(limit).all<{ id: string; time: number; amount: number; currency_code: number }>();
  return res.results ?? [];
}

export async function setTaxBase(db: AppDb, id: string, baseUah: number): Promise<void> {
  await db.prepare("UPDATE transactions SET tax_base_uah = ? WHERE id = ?").bind(baseUah, id).run();
}

/**
 * §TAX-BASE: `null` clears the override and hands the question back to the account.
 *
 * Returns whether a row was actually touched. An UPDATE that matches nothing is not an error in
 * SQL, so both of these used to answer `{ok:true}` for an id that names no row — and «the whole
 * account is now a business account» is exactly the claim a user would not re-check (A2 audit,
 * 2026-09-18).
 */
export async function setBusiness(db: AppDb, id: string, flag: 0 | 1 | null): Promise<boolean> {
  const res = await db.prepare("UPDATE transactions SET is_business = ? WHERE id = ?").bind(flag, id).run();
  return res.meta.changes > 0;
}

export async function setAccountBusiness(db: AppDb, id: string, flag: 0 | 1): Promise<boolean> {
  const res = await db.prepare("UPDATE accounts SET is_business = ? WHERE id = ?").bind(flag, id).run();
  return res.meta.changes > 0;
}

export interface Obligation {
  id: number;
  kind: string;
  period: string;
  amount: number;
  due_date: string;
  paid_tx_id: string | null;
  paid_at: number | null;
}

export async function listObligations(db: AppDb, fromPeriod: string): Promise<Obligation[]> {
  const res = await db.prepare(
    "SELECT id, kind, period, amount, due_date, paid_tx_id, paid_at FROM tax_obligations WHERE period >= ? ORDER BY due_date",
  ).bind(fromPeriod).all<Obligation>();
  return res.results ?? [];
}

/**
 * Write an accrual for one (kind, period).
 *
 * ⚠️ An obligation that is already PAID is never rewritten. While a period is open the accrual
 * follows the income and is recomputed on every read; once it has been paid it is history, and
 * history that moves because a rate table changed is the §BUDGET-MEMORY failure with a penalty
 * attached. The `WHERE paid_tx_id IS NULL` is the whole guard.
 */
export async function upsertObligation(
  db: AppDb, kind: string, period: string, amount: number, dueDate: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO tax_obligations (kind, period, amount, due_date, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, period) DO UPDATE SET amount = excluded.amount, due_date = excluded.due_date
     WHERE tax_obligations.paid_tx_id IS NULL`,
  ).bind(kind, period, amount, dueDate, Math.floor(Date.now() / 1000)).run();
}

/**
 * Drop the accruals of `periods` that the rules no longer produce, keeping `keep`.
 *
 * ⚠️ WHY A DELETE AT ALL, when `upsertObligation` already rewrites what changed: because changing
 * the GROUP changes the SHAPE of the accrual, not just its amount. Group 3 owes one quarterly
 * ЄП/ВЗ pair; groups 1–2 owe three monthly ones and nothing quarterly. An upsert-only refresh
 * wrote the new shape and left the old one standing, so one open quarter was billed twice and the
 * reserve — the number the whole module exists to state — told the user to set aside money the
 * state was never going to ask for. The same held for an ЄСВ exemption switched on and for a
 * council rate corrected down to zero: the accrual stopped being produced, and the last one it
 * produced stayed on the screen.
 *
 * ⚠️ PAID rows are never touched, exactly as in `upsertObligation`. A paid quarter is history, and
 * the user's own group change is not a reason to delete the record of what they already paid.
 */
export async function pruneObligations(
  db: AppDb, periods: string[], keep: { kind: string; period: string }[],
): Promise<void> {
  if (!periods.length) return;
  const keys = keep.map((k) => `${k.kind}|${k.period}`);
  // Scoped to the periods the caller just recomputed: a DELETE over everything unpaid would also
  // remove the accruals of quarters this refresh never looked at (`refreshObligations` covers the
  // recent ones on purpose), and those are the oldest unpaid debts — the ones worth keeping.
  const keepClause = keys.length
    ? ` AND (kind || '|' || period) NOT IN (${keys.map(() => "?").join(",")})`
    : "";
  await db.prepare(
    `DELETE FROM tax_obligations
      WHERE paid_tx_id IS NULL AND period IN (${periods.map(() => "?").join(",")})${keepClause}`,
  ).bind(...periods, ...keys).run();
}

/** Does this operation exist? The `paid_tx_id` foreign key is enforced, so the caller checks. */
export async function transactionExists(db: AppDb, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS n FROM transactions WHERE id = ?").bind(id).first<{ n: number }>();
  return !!row;
}

export interface PaymentCandidate {
  id: string;
  time: number;
  merchant: string | null;
  amount: number;
  category_id: number | null;
}

/**
 * §TAX-DUE — which operation actually PAID this obligation.
 *
 * «Paid» is a LINK, not a checkbox: §PLAN-LINK already settled this shape for subscriptions, and
 * the reason is the same here and stronger. With a link the sum reconciles itself and «paid less
 * than was accrued» is visible without a second field; with a checkbox the app knows only that
 * somebody pressed a button, which is a claim about money that nothing can check.
 *
 * What makes a row a candidate:
 *  · an EXPENSE in hryvnia — the state is paid in hryvnia (§TAX-UAH), so a foreign-currency row
 *    is not a candidate at all rather than one converted at some rate;
 *  · filed under the tax root (24) or not filed at all — the payment usually lands in 24, but an
 *    unfiled row is exactly what a fresh import looks like, and refusing it would send the user
 *    to categorise before they can link;
 *  · NEAR the amount, because the amount is the strong signal: the accrual and the payment are
 *    the same figure unless the user paid part of it;
 *  · NEAR the deadline, in a window that reaches BOTH ways — people pay early, and the overdue
 *    case is precisely the one worth linking;
 *  · not already the answer to another obligation, or one payment would settle two quarters.
 *
 * Ordered by how close the amount is, then the date: the row a human would pick first.
 */
export async function paymentCandidates(
  db: AppDb, amount: number, dueDate: string, days = 45, limit = 5,
): Promise<PaymentCandidate[]> {
  const due = Math.floor(Date.parse(`${dueDate}T00:00:00Z`) / 1000);
  // A tenth of the figure or 200 ₴, whichever is wider: the percentage carries the big quarterly
  // single tax, the floor keeps a 332,80 ₴ group-1 payment from having a 33 ₴ window nothing lands in.
  const tolerance = Math.max(Math.round(amount * 0.1), 20_000);
  const res = await db.prepare(
    `SELECT t.id, t.time, t.merchant, t.amount, t.category_id
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.currency_code = 980 AND t.amount < 0
       AND (t.category_id IS NULL OR COALESCE(c.parent_id, c.id) = 24)
       AND ABS(-t.amount - ?) <= ?
       AND t.time >= ? AND t.time <= ?
       AND t.id NOT IN (SELECT paid_tx_id FROM tax_obligations WHERE paid_tx_id IS NOT NULL)
     ORDER BY ABS(-t.amount - ?), ABS(t.time - ?)
     LIMIT ?`,
  ).bind(amount, tolerance, due - days * 86_400, due + days * 86_400, amount, due, limit)
    .all<PaymentCandidate>();
  return res.results ?? [];
}

export async function obligationById(db: AppDb, id: number): Promise<Obligation | null> {
  return await db.prepare(
    "SELECT id, kind, period, amount, due_date, paid_tx_id, paid_at FROM tax_obligations WHERE id = ?",
  ).bind(id).first<Obligation>();
}

/** Returns whether the obligation existed — see `setBusiness` for why the boolean is not optional. */
export async function markPaid(
  db: AppDb, id: number, txId: string | null, at: number | null,
): Promise<boolean> {
  const res = await db.prepare("UPDATE tax_obligations SET paid_tx_id = ?, paid_at = ? WHERE id = ?")
    .bind(txId, at, id).run();
  return res.meta.changes > 0;
}

// ─── the business side (§0.1 — questions the personal screens never ask) ────────────────────────

/** The spending half of `canonIncome` — same reasoning, same two leading placeholders. */
const canonSpend = (windowed = true) =>
  `t.id IN (SELECT t.id FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE}${
    windowed ? " AND t.time >= ? AND t.time < ?" : ""})`;

/**
 * What the business itself costs, ₴ minor, as a POSITIVE number.
 *
 * ⚠️ This is a REPORT, not a deduction. On the single tax, expenses do not reduce the base — the
 * screen has to say so, because a person who sees «робочі витрати» next to a tax figure will
 * reasonably assume the first lowers the second, and act on it.
 *
 * ⚠️ Valued at `amount`, not at a converted base: `tax_base_uah` is frozen for INCOME because a
 * declaration freezes it (§TAX-FX). An expense is never declared, so freezing it would invent a
 * second, differently-dated valuation of the same money. Foreign-currency work expenses are
 * counted at face value and reported apart, rather than silently mixed into a hryvnia total.
 */
export async function businessExpenses(
  db: AppDb, fromUnix: number, toUnix: number,
): Promise<{ uah: number; n: number; foreign_n: number }> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN t.currency_code = 980 THEN -t.amount ELSE 0 END), 0) AS uah,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN t.currency_code != 980 THEN 1 ELSE 0 END), 0) AS foreign_n
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${canonSpend()} AND ${IS_BUSINESS} = 1 AND t.amount < 0
       AND t.time >= ? AND t.time < ?`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix).first<{ uah: number; n: number; foreign_n: number }>();
  return row ?? { uah: 0, n: 0, foreign_n: 0 };
}

/**
 * Business income and cost per MONTH — the resolution quarters cannot give.
 *
 * Quarters answer «what do I owe»; months answer «how is the business going», which is the
 * question someone with no ФОП at all opens this page for (§BIZ-SPLIT). One statement rather than
 * two loops of `businessIncome`/`businessExpenses`: twelve months would otherwise be twenty-four
 * aggregate scans over the same table for one chart.
 *
 * ⚠️ §APP_TZ — bucketed through `localFmtSql`, like every other month bucket in this project. A
 * raw `strftime` would be UTC, and every receipt in the last three hours of a month would land in
 * the next one.
 *
 * ⚠️ Same population rule as the totals above: income is valued at its FROZEN base (§TAX-FX),
 * costs count hryvnia rows only — so a month here adds up to the quarter that contains it.
 */
export async function businessMonths(
  db: AppDb, fromUnix: number, toUnix: number, now: number,
): Promise<{ ym: string; income: number; costs: number }[]> {
  const res = await db.prepare(
    `SELECT ${localFmtSql(now, "%Y-%m", "t.time")} AS ym,
            COALESCE(SUM(CASE WHEN t.amount > 0 THEN COALESCE(${TAX_BASE}, 0) ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.amount < 0 AND t.currency_code = 980 THEN -t.amount ELSE 0 END), 0) AS costs
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${IS_BUSINESS} = 1 AND t.time >= ? AND t.time < ?
       AND (${canonIncome(false)} OR ${canonSpend(false)})
     GROUP BY ym ORDER BY ym`,
  ).bind(fromUnix, toUnix).all<{ ym: string; income: number; costs: number }>();
  return res.results ?? [];
}

/**
 * How much of ALL money that came in was the business's — the one figure that says whether this
 * page is about a side project or about the whole livelihood.
 *
 * Reuses `INCOME_WHERE`, the same canon as every income figure elsewhere (§CANON), so the
 * denominator here is the number the Statistics screen prints for the same window. A second
 * definition would let the two disagree about one month's income, and the believed one would be
 * whichever screen was opened last.
 */
export async function businessShare(
  db: AppDb, fromUnix: number, toUnix: number,
): Promise<{ business_uah: number; total_uah: number }> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ${IS_BUSINESS} = 1 THEN COALESCE(${TAX_BASE}, 0) ELSE 0 END), 0) AS business_uah,
            COALESCE(SUM(COALESCE(${TAX_BASE}, 0)), 0) AS total_uah
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${canonIncome()} AND t.time >= ? AND t.time < ?`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix).first<{ business_uah: number; total_uah: number }>();
  return row ?? { business_uah: 0, total_uah: 0 };
}

export interface BusinessExpenseRow {
  category_id: number;
  name: string;
  uah: number;
  n: number;
}

/**
 * WHERE the business's own costs go, by category root.
 *
 * ⚠️ Rolled up to `COALESCE(parent_id, id)` like every other breakdown in this project
 * (§Інваріанти): a work expense filed under «Софт і хмара» belongs with the rest of its root, and
 * a screen that split the two would disagree with the total printed above it.
 *
 * ⚠️ Hryvnia rows only, exactly as `businessExpenses` totals them — same population, same rule.
 * Valuing a foreign work expense would invent a second, differently-dated conversion of money
 * that is never declared (§TAX-FX freezes a base for INCOME because a declaration freezes it).
 * The count of those rows is reported by `businessExpenses`, so this list does not restate it.
 */
export async function businessExpensesByCategory(
  db: AppDb, fromUnix: number, toUnix: number, locale: NotifLocale, limit = 8,
): Promise<BusinessExpenseRow[]> {
  const res = await db.prepare(
    `SELECT COALESCE(c.parent_id, c.id) AS category_id,
            ${catNameSql(locale, "COALESCE(p.name, c.name)")} AS name,
            COALESCE(SUM(-t.amount), 0) AS uah,
            COUNT(*) AS n
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE ${canonSpend()} AND ${IS_BUSINESS} = 1 AND t.amount < 0
       AND t.currency_code = 980
       AND t.time >= ? AND t.time < ?
     GROUP BY category_id
     ORDER BY uah DESC
     LIMIT ?`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix, limit).all<BusinessExpenseRow>();
  return res.results ?? [];
}

export interface Counterparty {
  name: string;
  total_uah: number;
  n: number;
  first_at: number;
  last_at: number;
}

/**
 * WHO PAYS. The spending side has had `merchants.ts` since the beginning; the income side had
 * nothing — a client was a string in the feed and no screen ever grouped by it.
 *
 * Grouped by the merchant string as stored, deliberately NOT by a fuzzy root token the way
 * `consensusCategory` matches merchants. A client's name arrives from the bank the same way every
 * month, and merging two similar names would combine two real clients into one line — on the
 * spending side that costs a wrong chart, here it would misstate who your business depends on.
 */
export async function counterparties(
  db: AppDb, fromUnix: number, toUnix: number, limit = 20,
): Promise<Counterparty[]> {
  const res = await db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(t.merchant), ''), '?') AS name,
            COALESCE(SUM(COALESCE(${TAX_BASE}, 0)), 0) AS total_uah,
            COUNT(*) AS n, MIN(t.time) AS first_at, MAX(t.time) AS last_at
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${canonIncome()} AND ${IS_BUSINESS} = 1
       AND t.time >= ? AND t.time < ?
     GROUP BY name
     ORDER BY total_uah DESC
     LIMIT ?`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix, limit).all<Counterparty>();
  return res.results ?? [];
}

/** Every business receipt's timestamp in the window — the input to the rhythm reading. */
export async function receiptTimes(
  db: AppDb, fromUnix: number, toUnix: number, merchant?: string,
): Promise<number[]> {
  // `merchant` narrows it to ONE counterparty, for «has this client gone quiet». Grouped by the
  // name exactly as stored, the way `counterparties` groups: merging two similar names would
  // merge two real clients and misstate who the business depends on.
  const res = await db.prepare(
    `SELECT t.time AS time FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${canonIncome()} AND ${IS_BUSINESS} = 1 AND t.time >= ? AND t.time < ?
       AND (? IS NULL OR COALESCE(NULLIF(TRIM(t.merchant), ''), '?') = ?)
     ORDER BY t.time`,
  ).bind(fromUnix, toUnix, fromUnix, toUnix, merchant ?? null, merchant ?? null).all<{ time: number }>();
  return (res.results ?? []).map((r) => r.time);
}
