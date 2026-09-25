/**
 * §COMMITTED — how much of a typical month's income is already spoken for before any decision.
 *
 * `floor.ts` already knows what it costs this person to simply exist (§FLOOR: the repeating half of
 * the burn), but it only ever measures that against the CUSHION — «how long would I last». Against
 * INCOME the same number answers a different question: «how much room do I actually have», and its
 * trend answers «is that room shrinking». A floor that grows from 55% to 70% of income over half a
 * year is the quiet way a budget stops working, and no other screen can show it.
 *
 * ⚠️ **Nothing is recomputed.** The floor IS `burnShape(levels).recurring` (§FLOOR), the income IS
 * the mean of §FLOW-SERIES (the same series the health index reads). A subscription is NOT added on
 * top: its charges are spending in a category, so a subscription that repeats is already inside the
 * floor, and adding `sumMonthlyPlannedUAH` would count it twice.
 * ⚠️ **The tax reserve is NOT in it.** §TAX-RESERVE is an outstanding total, not a monthly rate, and
 * turning it into one would be a new definition of the tax. A quarterly tax PAYMENT is lumpy, so it
 * is not in the floor either — the card says «без разових», the same honesty §FLOOR keeps.
 * ⚠️ `share` can exceed 1: a floor bigger than income is the most important thing this can say.
 *
 * The trend re-asks the SAME two functions as of the first day of each of the last months, so every
 * point is what the app would have said then (with today's confirmed facts — §A1 has no history).
 */
import type { Env } from "../../env.ts";
import type { CommittedShare, CommittedPoint } from "../../../shared/api/insights.ts";
import type { Rates } from "./money.ts";
import { valueMode, localMonthStart, localYm } from "./stats.ts";
import { categoryMonthlyLevels, burnShape } from "./levels.ts";
import { monthlyFlowSeries, seriesMean } from "./flow-series.ts";

/** Points on the trend, current included. Six is the level window: older points share no months with today's. */
const TREND_POINTS = 6;

async function pointAt(env: Env, mult: string, at: number): Promise<CommittedPoint & { months: number }> {
  const [levels, flow] = await Promise.all([
    categoryMonthlyLevels(env, mult, { now: at }),
    monthlyFlowSeries(env, mult, at),
  ]);
  const floor = burnShape(levels).recurring;
  const mean = seriesMean(flow.incomes);
  const income = mean == null ? null : Math.round(mean);
  return {
    // Labelled by the last COMPLETE month the point rests on — «as of 1 September» is a statement
    // about February–August, and August is the month a person would name.
    ym: localYm(localMonthStart(at, -1)),
    floor, income,
    share: income != null && income > 0 ? floor / income : null,
    months: flow.keys.length,
  };
}

export async function committedShare(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<CommittedShare> {
  const { mult } = valueMode(rates, null);
  // k = 0 is the current month's first day: levels and the flow series read COMPLETE months only,
  // so «now» and «the 1st» describe the same window, and the current figure is simply the last point.
  const points = await Promise.all(
    Array.from({ length: TREND_POINTS }, (_, i) => pointAt(env, mult, localMonthStart(now, -(TREND_POINTS - 1 - i)))),
  );
  const cur = points[points.length - 1];
  return {
    floor: cur.floor,
    income: cur.income,
    free: cur.income == null ? null : cur.income - cur.floor,
    share: cur.share,
    months: cur.months,
    // A point with no income behind it is dropped rather than drawn at zero — it is missing, not low.
    trend: points.filter((p) => p.share != null).map(({ ym, floor, income, share }) => ({ ym, floor, income, share })),
  };
}
