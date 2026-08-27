// Planned payments / subscriptions. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { PlannedPayment } from "../../shared/types.ts";

/**
 * The fields `chargesBetween()` and `monthlyPlannedUAH()` need to build a schedule.
 *
 * `period_amount` is in the PLAN's own currency (§CUR-PLAN) and `period` is its own cadence
 * (§SUB-MONTH) — which is exactly why this returns the raw columns and never a sum. Five places
 * once summed `period_amount` directly: a $5 subscription weighed 5 ₴, and a quarterly plan
 * weighed a full charge every month. Converting and normalising is the canon's job, not a
 * query's, so the only safe thing to hand back is the plan itself.
 */
export interface PlanScheduleRow {
  period_amount: number | null;
  currency_code: number | null;
  period: string;
  period_count: number | null;
  start_date: number;
  end_date: number | null;
}

/**
 * §INCOME-PLAN — **`OUTFLOW_ONLY` is on every selector below, and that is the point.**
 *
 * `planned_payments` now also holds `kind = 'income'`, and `chargesBetween` is generic: it expands
 * whatever rows it is handed. So an income plan reaching any of these callers would be counted as
 * money LEAVING — quietly inflating "скоро спишеться", the cashflow calendar, the liquidity gap,
 * the monthly forecast and the advisor's subscription burden, all of which would still look
 * entirely plausible. Filtering at the call sites would mean five places remembering; filtering
 * here means a new caller gets it right by default and an income-aware caller has to ASK.
 */
const OUTFLOW_ONLY = "is_active = 1 AND COALESCE(kind, '') <> 'income'";

export async function activeForSchedule(db: AppDb): Promise<PlanScheduleRow[]> {
  const r = await db.prepare(
    `SELECT period_amount, currency_code, period, period_count, start_date, end_date
     FROM planned_payments WHERE ${OUTFLOW_ONLY}`,
  ).all<PlanScheduleRow>();
  return r.results ?? [];
}

/** The income side, for the one module allowed to reason about it (`lib/finance/income.ts`). */
export interface IncomePlanRow extends NamedPlanRow {
  category_id: number | null;
  amount_varies: number | null;
}

export async function activeIncomePlans(db: AppDb): Promise<IncomePlanRow[]> {
  const r = await db.prepare(
    `SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date,
            end_date, category_id, COALESCE(amount_varies, 0) AS amount_varies
     FROM planned_payments WHERE is_active = 1 AND kind = 'income'`,
  ).all<IncomePlanRow>();
  return r.results ?? [];
}

/** Same schedule fields plus identity, for callers that list the individual charges. */
export interface NamedPlanRow extends PlanScheduleRow {
  id: number;
  title: string;
  kind: string;
}

export async function activeWithTitles(db: AppDb): Promise<NamedPlanRow[]> {
  const r = await db.prepare(
    `SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date
     FROM planned_payments WHERE ${OUTFLOW_ONLY}`,
  ).all<NamedPlanRow>();
  return r.results ?? [];
}

/** As above, plus the category — subscriptions are spread across real categories, not the
 *  "Subscriptions" one (internet is a utility, cloud storage is software), so callers that
 *  attribute a charge need it. */
export interface CategorisedPlanRow extends NamedPlanRow {
  category_id: number | null;
}

export async function activeWithCategory(db: AppDb): Promise<CategorisedPlanRow[]> {
  const r = await db.prepare(
    `SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date,
            category_id
     FROM planned_payments WHERE ${OUTFLOW_ONLY}`,
  ).all<CategorisedPlanRow>();
  return r.results ?? [];
}

/** Every column, for the plans screen. */
export async function listActive(db: AppDb): Promise<PlannedPayment[]> {
  const r = await db.prepare("SELECT * FROM planned_payments WHERE is_active = 1").all<PlannedPayment>();
  return r.results ?? [];
}

// ---- writes -----------------------------------------------------------------

export interface NewPlan {
  title: string;
  kind: string;
  total_amount: number | null;
  period_amount: number | null;
  period: string;
  period_count: number;
  start_date: number;
  /** Derived for an instalment (§6.5); null for an open-ended subscription. */
  end_date: number | null;
  occurrences: number | null;
  category_id: number | null;
  account_id: string | null;
  currency_code: number;
  /** §INCOME-PLAN — the amount is an estimate, not a promise. */
  amount_varies?: boolean;
}

export async function create(db: AppDb, p: NewPlan): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO planned_payments (title, kind, total_amount, period_amount, period, period_count, start_date, end_date, occurrences, category_id, account_id, currency_code, amount_varies, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).bind(p.title, p.kind, p.total_amount, p.period_amount, p.period, p.period_count,
    p.start_date, p.end_date, p.occurrences, p.category_id, p.account_id, p.currency_code,
    p.amount_varies ? 1 : 0).run();
  return r.meta.last_row_id;
}

/** Partial update. @returns false when the patch was empty, so the caller can skip the write. */
export async function update(
  db: AppDb, id: number, patch: { note?: string | null; category_id?: number | null },
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["note", "category_id"] as const) {
    const v = patch[col];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (!sets.length) return false;
  await db.prepare(`UPDATE planned_payments SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return true;
}

/**
 * Soft delete. Past charges still point at the plan (`transactions.planned_id`), and the canon
 * reads that link to tell a recurring expense from a one-off (§E1) — a hard delete would rewrite
 * history months back.
 */
export async function deactivate(db: AppDb, id: number): Promise<void> {
  await db.prepare("UPDATE planned_payments SET is_active = 0 WHERE id = ?").bind(id).run();
}

// ---- subscription detection -------------------------------------------------

/**
 * Every candidate CHARGE, unaggregated — the grouping is judgement and lives in
 * `lib/finance/recurring.ts` (§SUB-DETECT).
 *
 * It used to be one `GROUP BY t.merchant, t.amount`, which recognised a subscription by the exact
 * amount repeating under the exact merchant string. That cannot see a foreign-currency
 * subscription at all (it settles at the day's rate, so the amount differs every month — which is
 * most of the ones a person actually has), split «X Corp.» from «X Corp», and never measured
 * rhythm: exact-amount equality was standing in for it. SQL cannot express "same merchant roughly"
 * (`coreToken`) or an amount BUCKET, and forcing it to would produce a second definition of both.
 *
 * §G2: transfers and bucket 13 (with its children) stay excluded here — "balance rounding" and
 * money sent to a person are not subscriptions, and that is a property of the LEDGER, not of the
 * grouping. Holds are counted, as everywhere else in canon.
 *
 * ⚠️ `LIMIT` is a cost ceiling, not a rule: newest first, so a long ledger loses its oldest rows
 * rather than a random half. The window (`since`) is what really bounds this.
 */
export interface DetectedCharge {
  merchant: string;
  amount: number;            // minor units, POSITIVE
  time: number;
  currency_code: number;
  category_id: number | null;
}

export async function detectCharges(db: AppDb, since: number, limit = 4000): Promise<DetectedCharge[]> {
  const r = await db.prepare(
    `SELECT t.merchant, -t.amount AS amount, t.time, t.currency_code,
            COALESCE(c.parent_id, t.category_id) AS category_id
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.amount < 0 AND t.is_transfer = 0 AND t.transfer_pair_id IS NULL
       AND t.merchant IS NOT NULL AND t.merchant <> '' AND t.time >= ?
       AND COALESCE(c.parent_id, t.category_id) IS NOT 13
     ORDER BY t.time DESC LIMIT ?`,
  ).bind(since, limit).all<DetectedCharge>();
  return r.results ?? [];
}

/**
 * §AI-RECURRING — charges the MODEL flagged as a subscription, grouped by merchant.
 *
 * The deterministic detector needs two months to see a rhythm. This is the other half: on the day
 * the first charge lands, enrich has already looked at the operation and can say "this is a
 * subscription" — and that is the one moment the user still remembers signing up.
 *
 * ⚠️ Rows already tied to a plan are excluded, and so is bucket 13 (§G2): a proposal to create
 * something that exists is worse than no proposal, and a transfer is never a subscription.
 * ⚠️ The newest charge decides the amount, not an average: with one or two charges there is
 * nothing to average, and the latest price is the one that will be billed next.
 */
export interface AiRecurringRow {
  merchant: string; amount: number; currency_code: number;
  n: number; first_time: number; last_time: number; category_id: number | null;
}

export async function aiRecurringCandidates(db: AppDb, since: number): Promise<AiRecurringRow[]> {
  const r = await db.prepare(
    `SELECT t.merchant,
            (SELECT -x.amount FROM transactions x
             WHERE x.merchant = t.merchant AND x.currency_code = t.currency_code AND x.amount < 0
             ORDER BY x.time DESC LIMIT 1) AS amount,
            t.currency_code, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            COALESCE(c.parent_id, t.category_id) AS category_id
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.ai_recurring = 1 AND t.amount < 0 AND t.is_transfer = 0 AND t.planned_id IS NULL
       AND t.merchant IS NOT NULL AND t.merchant <> '' AND t.time >= ?
       AND COALESCE(c.parent_id, t.category_id) IS NOT 13
     GROUP BY t.merchant, t.currency_code
     ORDER BY last_time DESC LIMIT 12`,
  ).bind(since).all<AiRecurringRow>();
  return r.results ?? [];
}

export interface MerchantMatch {
  merchant: string;
  currency_code: number;
  avg_amount: number;
  n: number;
  first_time: number;
  last_time: number;
  category_id: number | null;
}

/**
 * Spending grouped by merchant+currency for a free-text search — the §F4 "describe it" flow.
 *
 * ⚠️ **Holds are COUNTED**, like everywhere else (canon, `stats.ts`): monobank only sends executed
 * operations, and when a hold settles the SAME id is overwritten, so there is no double count.
 * Two of the three planning queries carried `t.hold = 0` and nothing said why — the visible cost
 * was that the average charge shown in this SEARCH differed from the one `merchantProfile` uses
 * for the plan created by clicking that very row. The rule already records that `hold = 0` once
 * cut the freshest week out of a report; this was the same cut, in the flow whose whole purpose
 * is "turn a recent repeating charge into a plan".
 */
/**
 * The text a subscription search looks through — the merchant, the RAW bank description, the
 * user's comment and the AI's own note about the operation.
 *
 * ⚠️ `ai_note` is the point (2026-08-27). The owner had told the AI, on the transaction itself,
 * that «X Corp.» is his Twitter subscription; the model understood and wrote it down — and then
 * searching for «твітер» found nothing, because the search read `merchant` alone. The app had the
 * answer stored and refused to look at it. Same shape as §RULES-UI: what the engine matches and
 * what the person sees must be the same text.
 * ⚠️ `raw_json.$.description` before `merchant`, for the same reason as `textHaystack` in
 * `repo/rules.ts` — for an enriched row `merchant` is a clean name the bank never sent.
 */
const searchHaystack = (a = "t.") =>
  `COALESCE(${a}merchant, '') || ' ' || COALESCE(json_extract(${a}raw_json, '$.description'), '') ` +
  `|| ' ' || COALESCE(${a}comment, '') || ' ' || COALESCE(${a}ai_note, '')`;

/**
 * Case variants of one search term.
 *
 * SQLite's `LIKE` folds case for ASCII ONLY, and `LOWER()` does the same — so «твітер» never
 * matches «Твітер» and a Cyrillic search silently depends on how the text happened to be typed.
 * Two variants (as given, and capitalised) cover what actually occurs in merchant names and notes;
 * a full Unicode fold would need a collation D1 does not offer.
 */
function likeVariants(term: string): string[] {
  const low = term.toLowerCase();
  const cap = low.charAt(0).toUpperCase() + low.slice(1);
  return [...new Set([low, cap, term])].map((v) => `%${v}%`);
}

/**
 * Spending grouped by merchant+currency for a free-text search — the §F4 "describe it" flow.
 *
 * ⚠️ **Holds are COUNTED**, like everywhere else (canon, `stats.ts`): monobank only sends executed
 * operations, and when a hold settles the SAME id is overwritten, so there is no double count.
 * Two of the three planning queries carried `t.hold = 0` and nothing said why — the visible cost
 * was that the average charge shown in this SEARCH differed from the one `merchantProfile` uses
 * for the plan created by clicking that very row. The rule already records that `hold = 0` once
 * cut the freshest week out of a report; this was the same cut, in the flow whose whole purpose
 * is "turn a recent repeating charge into a plan".
 * ⚠️ **Several terms, OR-ed** (2026-08-27): one keyword cannot span a rename. The model is asked
 * for the brand's aliases («X», «Twitter», «твітер») precisely because the ledger holds one of
 * them and the person remembers another.
 * ⚠️ **Terms shorter than `MIN_TERM` are dropped by the caller, never searched.** `LIKE '%X%'`
 * matches OnTa**x**i, E**x**pres and PADDLE.NET — that screenful of noise was the bug report.
 */
export async function merchantMatches(
  db: AppDb, terms: string[], since: number,
): Promise<MerchantMatch[]> {
  const binds: string[] = [];
  const clauses: string[] = [];
  for (const term of terms.slice(0, 6)) {
    for (const v of likeVariants(term)) { clauses.push(`${searchHaystack()} LIKE ?`); binds.push(v); }
  }
  if (!clauses.length) return [];
  const r = await db.prepare(
    `SELECT t.merchant, t.currency_code, -AVG(t.amount) AS avg_amount, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            (SELECT x.category_id FROM transactions x
             WHERE x.merchant = t.merchant AND x.category_id IS NOT NULL
             GROUP BY x.category_id ORDER BY COUNT(*) DESC LIMIT 1) AS category_id
     FROM transactions t
     WHERE t.amount < 0 AND t.is_transfer = 0 AND t.time >= ? AND (${clauses.join(" OR ")})
     GROUP BY t.merchant, t.currency_code
     HAVING n >= 1 ORDER BY n DESC, last_time DESC LIMIT 8`,
  ).bind(since, ...binds).all<MerchantMatch>();
  return r.results ?? [];
}

/**
 * Everything needed to turn ONE known merchant into a plan: its typical charge, in its OWN
 * currency, plus when it started and where it usually lands.
 *
 * Exact match on the merchant, not `LIKE` as in `merchantMatches`: this one is not a search, it
 * is "the row the user just pointed at", and a `LIKE` would happily also fold in a longer name
 * that merely contains it.
 *
 * ⚠️ `avg_amount` is in `currency_code`, NOT converted to UAH — `planned_payments.period_amount`
 * is stored in the plan's own currency (§CUR-PLAN). Handing this a ₴-converted figure together
 * with a USD `currency_code` is precisely the bug that made a $5 subscription weigh 5 ₴.
 * Grouped by currency and the busiest group wins, because a merchant that changed currency mid-way
 * has two answers and only the current one is a plan.
 */
export async function merchantProfile(
  db: AppDb, merchant: string, since: number,
): Promise<MerchantMatch | null> {
  const r = await db.prepare(
    `SELECT t.merchant, t.currency_code, -AVG(t.amount) AS avg_amount, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            (SELECT x.category_id FROM transactions x
             WHERE x.merchant = t.merchant AND x.category_id IS NOT NULL
             GROUP BY x.category_id ORDER BY COUNT(*) DESC LIMIT 1) AS category_id
     FROM transactions t
     WHERE t.amount < 0 AND t.is_transfer = 0 AND t.merchant = ? AND t.time >= ?
     GROUP BY t.currency_code
     ORDER BY n DESC LIMIT 1`,
  ).bind(merchant, since).first<MerchantMatch>();
  return r ?? null;
}

/** Lower-cased titles of declared plans — a candidate matching one is already known. */
export async function declaredTitles(db: AppDb): Promise<Set<string>> {
  const r = await db.prepare(
    "SELECT LOWER(title) AS title FROM planned_payments WHERE is_active = 1",
  ).all<{ title: string }>();
  return new Set((r.results ?? []).map((d) => d.title));
}

/**
 * The declared plans as NAMEABLE things — title plus note, which is where a plan's other names
 * live (§SUB-ALIAS: the plan «Twitter» carries «X Corp.» in its note).
 *
 * `declaredTitles` above answers a narrower question ("is this exact string already a plan") and
 * still has its caller in `habits.ts`. Detection needs the wider one, or it proposes creating a
 * plan the user already has under the brand's other name.
 */
export async function declaredPlans(db: AppDb): Promise<{ title: string; note: string | null }[]> {
  const r = await db.prepare(
    "SELECT title, note FROM planned_payments WHERE is_active = 1",
  ).all<{ title: string; note: string | null }>();
  return r.results ?? [];
}

/** §R5: candidates the user has closed with "this is not a subscription". */
export async function dismissedMerchants(db: AppDb): Promise<Set<string>> {
  const r = await db.prepare("SELECT merchant FROM planned_dismissed").all<{ merchant: string }>();
  return new Set((r.results ?? []).map((d) => d.merchant));
}

/** Stored lower-cased, because that is how `dismissedMerchants` is compared against. */
export async function dismissMerchant(db: AppDb, merchant: string, at: number): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO planned_dismissed (merchant, created_at) VALUES (?, ?)",
  ).bind(merchant.toLowerCase(), at).run();
}

// ---- one plan, in detail (§SUB-PAGE) ----------------------------------------

/** Every column of one plan, whether or not it is still active. */
export async function byId(db: AppDb, id: number): Promise<PlannedPayment | null> {
  return await db.prepare("SELECT * FROM planned_payments WHERE id = ?").bind(id).first<PlannedPayment>();
}

export interface PlanCharge {
  id: string; time: number; amount: number; currency_code: number; amount_base: number;
}

/**
 * The actual charges linked to a plan, newest first.
 *
 * ⚠️ Two amounts, deliberately. `amount` stays in the currency the card was charged in — that is
 * the figure on the statement and the one a price rise is visible in. `amount_base` is the same
 * charge rolled up into the reader's unit (§BASE-CUR), which is the only way a total or a share
 * of anything means something. Showing one and calling it the other is how a $5 subscription once
 * weighed 5 ₴ (§CUR-PLAN).
 * ⚠️ No `STATS_JOINS`: a subscription charge is a whole transaction that either happened or did
 * not. Splitting one across categories is a statement about where the money went, not about what
 * the biller took, and asking for the split half here would report a charge the bank never made.
 */
export async function planCharges(
  db: AppDb, id: number, mult: string, limit = 36,
): Promise<PlanCharge[]> {
  const r = await db.prepare(
    `SELECT t.id, t.time, ABS(t.amount) AS amount, t.currency_code,
            CAST(ROUND(ABS(t.amount) * ${mult}) AS INTEGER) AS amount_base
     FROM transactions t
     WHERE t.planned_id = ? AND t.amount < 0 AND t.is_transfer = 0
     ORDER BY t.time DESC LIMIT ?`,
  ).bind(id, limit).all<PlanCharge>();
  return r.results ?? [];
}

export interface PlanTotals { n: number; first_time: number | null; last_time: number | null; total_base: number }

export async function planTotals(db: AppDb, id: number, mult: string): Promise<PlanTotals> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n, MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            CAST(ROUND(COALESCE(SUM(ABS(t.amount) * ${mult}), 0)) AS INTEGER) AS total_base
     FROM transactions t
     WHERE t.planned_id = ? AND t.amount < 0 AND t.is_transfer = 0`,
  ).bind(id).first<PlanTotals>();
  return r ?? { n: 0, first_time: null, last_time: null, total_base: 0 };
}
