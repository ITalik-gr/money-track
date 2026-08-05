// Planned payments / subscriptions. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";

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

export async function activeForSchedule(db: AppDb): Promise<PlanScheduleRow[]> {
  const r = await db.prepare(
    "SELECT period_amount, currency_code, period, period_count, start_date, end_date FROM planned_payments WHERE is_active = 1",
  ).all<PlanScheduleRow>();
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
    "SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date FROM planned_payments WHERE is_active = 1",
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
    "SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date, category_id FROM planned_payments WHERE is_active = 1",
  ).all<CategorisedPlanRow>();
  return r.results ?? [];
}

/** Every column, for the plans screen. */
export async function listActive(db: AppDb): Promise<Record<string, unknown>[]> {
  const r = await db.prepare("SELECT * FROM planned_payments WHERE is_active = 1").all();
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
}

export async function create(db: AppDb, p: NewPlan): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO planned_payments (title, kind, total_amount, period_amount, period, period_count, start_date, end_date, occurrences, category_id, account_id, currency_code, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).bind(p.title, p.kind, p.total_amount, p.period_amount, p.period, p.period_count,
    p.start_date, p.end_date, p.occurrences, p.category_id, p.account_id, p.currency_code).run();
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

export interface DetectedCandidate {
  merchant: string;
  amount: number;
  n: number;
  first_time: number;
  last_time: number;
  months: number;
  currency_code: number;
  category_id: number | null;
}

/**
 * Recurring-charge candidates: the same merchant and amount, in ≥2 distinct months. Heuristic,
 * no AI.
 *
 * §G2: transfers and bucket 13 (with its children) are excluded, or "balance rounding" and money
 * sent to a person become "subscriptions". §G3: the sub-select proposes the most common category
 * among the matches, so accepting a candidate does not land it uncategorised.
 */
export async function detectCandidates(db: AppDb, since: number): Promise<DetectedCandidate[]> {
  const r = await db.prepare(
    `SELECT t.merchant, -t.amount AS amount, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            COUNT(DISTINCT strftime('%Y-%m', t.time, 'unixepoch')) AS months,
            t.currency_code AS currency_code,
            (SELECT x.category_id FROM transactions x
             WHERE x.merchant = t.merchant AND x.amount = t.amount AND x.category_id IS NOT NULL
             GROUP BY x.category_id ORDER BY COUNT(*) DESC LIMIT 1) AS category_id
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.amount < 0 AND t.hold = 0 AND t.is_transfer = 0
       AND t.merchant IS NOT NULL AND t.merchant <> '' AND t.time >= ?
       AND COALESCE(c.parent_id, t.category_id) IS NOT 13
     GROUP BY t.merchant, t.amount
     HAVING n >= 2 AND months >= 2
     ORDER BY n DESC, last_time DESC LIMIT 40`,
  ).bind(since).all<DetectedCandidate>();
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

/** Spending grouped by merchant+currency for a free-text search — the §F4 "describe it" flow. */
export async function merchantMatches(
  db: AppDb, query: string, since: number,
): Promise<MerchantMatch[]> {
  const r = await db.prepare(
    `SELECT t.merchant, t.currency_code, -AVG(t.amount) AS avg_amount, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            (SELECT x.category_id FROM transactions x
             WHERE x.merchant = t.merchant AND x.category_id IS NOT NULL
             GROUP BY x.category_id ORDER BY COUNT(*) DESC LIMIT 1) AS category_id
     FROM transactions t
     WHERE t.amount < 0 AND t.is_transfer = 0 AND t.hold = 0 AND t.merchant LIKE ? AND t.time >= ?
     GROUP BY t.merchant, t.currency_code
     HAVING n >= 1 ORDER BY n DESC, last_time DESC LIMIT 8`,
  ).bind(`%${query}%`, since).all<MerchantMatch>();
  return r.results ?? [];
}

/** Lower-cased titles of declared plans — a candidate matching one is already known. */
export async function declaredTitles(db: AppDb): Promise<Set<string>> {
  const r = await db.prepare(
    "SELECT LOWER(title) AS title FROM planned_payments WHERE is_active = 1",
  ).all<{ title: string }>();
  return new Set((r.results ?? []).map((d) => d.title));
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
