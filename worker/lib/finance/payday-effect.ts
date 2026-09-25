/**
 * §PAYDAY-EFFECT — how much faster discretionary money leaves in the week after income lands.
 *
 * Nothing in the app measured spending RELATIVE TO income arriving, and it is the behaviour budgets
 * most often miss: the week after the money comes feels rich, and a month's slack goes in it.
 * Anchored on REAL receipts, not on a detected payday (`detectPaydays` needs a fixed day of the
 * month), so it works for irregular — ФОП — income too.
 *
 * Definitions, all from the canon:
 *  · a receipt is canonical income (`INCOME_WHERE`, `incomeSum` per operation) of at least a quarter
 *    of a typical month's income (§FLOW-SERIES); receipts within 3 days are ONE event (a salary and
 *    its bonus the next day are one arrival);
 *  · «discretionary» is canonical spend (`SPEND_WHERE`) that is not linked to a plan and whose
 *    importance is not `essential` — rent paid on payday is a bill, not a behaviour;
 *  · the baseline is the same population's spend per 7 days across the whole window;
 *  · only events whose full week lies inside the window count, and fewer than 3 events is null — a
 *    sample, in §CADENCE's spirit, not an anecdote.
 */
import type { Env } from "../../env.ts";
import type { Rates } from "./money.ts";
import type { PaydayEffect } from "../../../shared/api/insights.ts";
import {
  STATS_JOINS, SPEND_WHERE, INCOME_WHERE, EFF_IMPORTANCE, amountSum, incomeSum, valueMode, localMonthStart,
} from "./stats.ts";
import { monthlyFlowSeries, seriesMean } from "./flow-series.ts";

const DAY = 86400;
const WEEK = 7 * DAY;
const MIN_EVENTS = 3;
const RECEIPT_SHARE = 0.25;
const MERGE_DAYS = 3;
const WINDOW_MONTHS = 6;

const DISCRETIONARY = `${SPEND_WHERE} AND t.planned_id IS NULL AND ${EFF_IMPORTANCE} <> 'essential'`;

/** Receipts → events: sorted, merged when closer than `MERGE_DAYS`. Pure, for the tests. */
export function receiptEvents(times: number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] >= MERGE_DAYS * DAY) out.push(t);
  }
  return out;
}

export async function paydayEffect(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<PaydayEffect> {
  const { mult } = valueMode(rates, null);
  const from = localMonthStart(now, -WINDOW_MONTHS);
  const to = localMonthStart(now);
  const none: PaydayEffect = { events: 0, typical_week: null, after_week: null, ratio: null };

  const flow = await monthlyFlowSeries(env, mult, now, WINDOW_MONTHS);
  const typical = seriesMean(flow.incomes);
  if (typical == null || typical <= 0) return none;

  const receipts = await env.DB.prepare(
    `SELECT t.time AS time, ${incomeSum(mult)} AS amt
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${INCOME_WHERE}
     GROUP BY t.id`,
  ).bind(from, to).all<{ time: number; amt: number }>();
  const events = receiptEvents((receipts.results ?? []).filter((r) => r.amt >= typical * RECEIPT_SHARE).map((r) => r.time))
    .filter((t) => t + WEEK <= to);
  if (events.length < MIN_EVENTS) return { ...none, events: events.length };

  const sumBetween = async (a: number, b: number) => (await env.DB.prepare(
    `SELECT ${amountSum(mult)} AS s FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${DISCRETIONARY}`,
  ).bind(a, b).first<{ s: number | null }>())?.s ?? 0;

  // The window starts where the ledger starts, or a quiet pre-history would dilute the baseline.
  const firstRow = await env.DB.prepare("SELECT MIN(time) AS t FROM transactions").first<{ t: number | null }>();
  const start = Math.max(from, firstRow?.t ?? from);
  const days = Math.max(1, (to - start) / DAY);
  const typicalWeek = (await sumBetween(start, to)) / days * 7;
  if (typicalWeek <= 0) return { ...none, events: events.length };

  const weeks = await Promise.all(events.map((t) => sumBetween(t, t + WEEK)));
  const afterWeek = weeks.reduce((s, v) => s + v, 0) / weeks.length;
  return {
    events: events.length,
    typical_week: Math.round(typicalWeek),
    after_week: Math.round(afterWeek),
    ratio: Math.round((afterWeek / typicalWeek) * 100) / 100,
  };
}
