/**
 * §INCOME-RHYTHM — not how MUCH income, but how it ARRIVES.
 *
 * `incomeOutlook` forecasts the amount; §INCOME-CV says how uneven the months are. Neither says the
 * thing that decides a ФОП's month: the longest stretch with nothing coming in, how long it has
 * been since the last payment, and in how many months income actually covered the recurring floor.
 * A good annual total with a two-month hole is a different life from an even one.
 *
 * All canon: receipts are canonical income ≥ ¼ of the §FLOW-SERIES typical month, merged within 3
 * days (the same events §PAYDAY-EFFECT uses); the floor is §FLOOR's; the months are §FLOW-SERIES'.
 * Foreign income is valued the way the canon values it everywhere (`incomeSum` with the ledger's
 * rates) — §TAX-FX's frozen NBU rate is the TAX view and deliberately not used here.
 */
import type { Env } from "../../env.ts";
import type { Rates } from "./money.ts";
import type { IncomeRhythm } from "../../../shared/api/insights.ts";
import { STATS_JOINS, INCOME_WHERE, incomeSum, valueMode, localMonthStart } from "./stats.ts";
import { categoryMonthlyLevels, burnShape } from "./levels.ts";
import { monthlyFlowSeries, seriesMean, incomeCv } from "./flow-series.ts";
import { receiptEvents } from "./payday-effect.ts";

const DAY = 86400;
const WINDOW_MONTHS = 6;

/** The longest wait between arrivals, counting the one still running at `now`. Pure, for the tests. */
export function longestGapDays(events: number[], now: number): number | null {
  if (!events.length) return null;
  let longest = 0;
  for (let i = 1; i < events.length; i++) longest = Math.max(longest, events[i] - events[i - 1]);
  longest = Math.max(longest, now - events[events.length - 1]);
  return Math.floor(longest / DAY);
}

export async function incomeRhythm(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<IncomeRhythm> {
  const { mult } = valueMode(rates, null);
  const [flow, levels] = await Promise.all([
    monthlyFlowSeries(env, mult, now, WINDOW_MONTHS),
    categoryMonthlyLevels(env, mult, { now }),
  ]);
  const typical = seriesMean(flow.incomes);
  const cv = incomeCv(flow.incomes);
  const floor = burnShape(levels).recurring;
  const base: IncomeRhythm = {
    months: flow.keys.length,
    covered_floor: null, longest_gap_days: null, days_since_last: null,
    cv_pct: cv == null ? null : Math.round(cv * 100),
  };
  if (typical == null || typical <= 0) return base;

  const rows = await env.DB.prepare(
    `SELECT t.time AS time, ${incomeSum(mult)} AS amt
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${INCOME_WHERE}
     GROUP BY t.id`,
  ).bind(localMonthStart(now, -WINDOW_MONTHS), now).all<{ time: number; amt: number }>();
  const events = receiptEvents((rows.results ?? []).filter((r) => r.amt >= typical / 4).map((r) => r.time));
  return {
    ...base,
    covered_floor: floor > 0 ? flow.incomes.filter((v) => v >= floor).length : null,
    longest_gap_days: longestGapDays(events, now),
    days_since_last: events.length ? Math.floor((now - events[events.length - 1]) / DAY) : null,
  };
}
