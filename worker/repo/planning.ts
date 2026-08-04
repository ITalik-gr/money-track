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
