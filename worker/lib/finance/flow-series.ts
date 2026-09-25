/**
 * §FLOW-SERIES — income and spend per COMPLETE month the ledger covers, zero-filled. One
 * definition of «a typical month's income», read by every verdict that needs it.
 *
 * Extracted from `health.ts` on 2026-09-25, when §COMMITTED and §INCOME-RHYTHM needed the same
 * series. The alternative — each of them writing its own `GROUP BY month` — is exactly how the
 * health index once put a canonical LEVEL on one side of a ratio and a raw average on the other
 * and showed −15% savings where fact-against-fact was −5%.
 *
 * Two rules travel with it, both bought by bugs:
 *  · §HEALTH-INCOME — a month with NO income is a month and counts (zero-filled). `GROUP BY` returns
 *    no row for it, and the old code then averaged only the good months: a jobless month made
 *    income look more stable.
 *  · `fullyCoveredMonths`, never `coveredMonths`: a verdict must not grade months the ledger does
 *    not have. For an empty or brand-new account the series is EMPTY, and every reader has to
 *    treat that as «not measurable», not as zeros.
 *
 * The current month is never in it — it is partial by definition.
 */
import type { Env } from "../../env.ts";
import {
  STATS_JOINS, incomeSum, spendSum, localMonthStart, localYm, localYmSql,
} from "./stats.ts";
import { fullyCoveredMonths } from "./levels.ts";

export interface FlowSeries {
  /** `YYYY-MM`, oldest first — only months the ledger fully covers. */
  keys: string[];
  /** Base-currency minor units per key, never negative. */
  incomes: number[];
  spends: number[];
}

export async function monthlyFlowSeries(
  env: Env, mult: string, now: number, months = 6,
): Promise<FlowSeries> {
  const from = localMonthStart(now, -months);
  const monthStart = localMonthStart(now);
  const rows = await env.DB.prepare(
    `SELECT ${localYmSql(now)} AS m, ${incomeSum(mult)} AS income, ${spendSum(mult)} AS spend
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? GROUP BY m ORDER BY m`,
  ).bind(from, monthStart).all<{ m: string; income: number; spend: number }>();
  const all: string[] = [];
  for (let i = months; i >= 1; i--) all.push(localYm(localMonthStart(now, -i)));
  const keys = await fullyCoveredMonths(env, all);
  const byMonth = new Map((rows.results ?? []).map((r) => [r.m, r]));
  return {
    keys,
    incomes: keys.map((k) => Math.max(0, byMonth.get(k)?.income ?? 0)),
    spends: keys.map((k) => Math.max(0, byMonth.get(k)?.spend ?? 0)),
  };
}

/** Mean of a series, or null for an empty one — «no months» is not «zero». */
export function seriesMean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

/**
 * §INCOME-CV — how uneven income is month to month: population stddev ÷ mean over a ZERO-FILLED
 * series of covered months. Null with fewer than two months (one value has no spread) or a zero
 * mean (no income is not «perfectly stable income» — §HEALTH scores it 0).
 *
 * One definition, 2026-09-25. There were two: the health index's (zero-filled) and
 * `/analytics/income`'s, which averaged only the months that HAD income — the exact §HEALTH-INCOME
 * bug, alive on the income card: a jobless month made income read as more stable, and the card and
 * the health index could call the same income «стабільний» and «нестабільний» at once.
 */
export function incomeCv(incomes: number[]): number | null {
  if (incomes.length < 2) return null;
  const mean = incomes.reduce((s, v) => s + v, 0) / incomes.length;
  if (mean <= 0) return null;
  return Math.sqrt(incomes.reduce((s, v) => s + (v - mean) ** 2, 0) / incomes.length) / mean;
}
