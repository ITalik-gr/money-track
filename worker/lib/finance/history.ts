/**
 * §IMPORTANCE-TREND — the long horizon: spend, income and the weight split, month by month.
 *
 * Split out of the route under lint C3, and the seam is real: the window, the ₴ roll-up, the join
 * of two grouped queries and the zero-fill are all decisions ABOUT this view, not transport. The
 * route is left with one line, which is what a route should be.
 *
 * What it adds over the period tabs: those answer "what share of THIS month was optional". They
 * cannot answer the question that matters more — whether the optional share is CLIMBING. A growing
 * total says nothing on its own, because a bigger rent and a bigger takeaway habit look identical
 * in it, and only one of them is a decision anyone can revisit.
 */
import type { Env } from "../../env.ts";
import { getRates } from "./money.ts";
import { valueMode, localMonthStart, localYm } from "./stats.ts";
import type { MonthlyHistory } from "../../../shared/api/analytics.ts";

export async function collectMonthlyHistory(env: Env, months: number): Promise<MonthlyHistory> {
  const analyticsRepo = await import("../../repo/analytics.ts");
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);   // always ₴ — the axis compares months with each other
  const now = Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -(months - 1));

  const [rows, imp] = await Promise.all([
    analyticsRepo.monthlyHistory(env.DB, { mult }, now, from),
    // One extra grouped query rather than a second endpoint: it is the same months over the same
    // window, and two requests would let the halves answer for different periods.
    analyticsRepo.importanceByMonth(env.DB, { mult }, now, from),
  ]);

  const byMonth = new Map<string, { essential: number; discretionary: number; optional: number }>();
  for (const r of imp) {
    const cur = byMonth.get(r.month) ?? { essential: 0, discretionary: 0, optional: 0 };
    // `EFF_IMPORTANCE` falls back to 'discretionary', so anything unrecognised belongs there and
    // nothing can fall outside the three — which is what makes them add up to `spend`.
    if (r.importance === "essential") cur.essential = r.spent;
    else if (r.importance === "optional") cur.optional = r.spent;
    else cur.discretionary = r.spent;
    byMonth.set(r.month, cur);
  }

  // Missing months (no operations at all) are filled with zeros so the axis stays continuous: a
  // gap would make the line jump between distant months as though they were adjacent.
  const spendByMonth = new Map(rows.map((r) => [r.month, r]));
  const out: MonthlyHistory["months"] = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = localYm(localMonthStart(now, -i));
    const r = spendByMonth.get(key);
    const w = byMonth.get(key) ?? { essential: 0, discretionary: 0, optional: 0 };
    out.push({ month: key, spend: r?.spend ?? 0, income: r?.income ?? 0, ...w });
  }
  return { months: out };
}
