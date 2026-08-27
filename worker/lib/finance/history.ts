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
import { savingsRatePct } from "./finance.ts";
import { resolveLocale, st } from "../platform/i18n.ts";
import type { MonthlyHistory } from "../../../shared/api/analytics.ts";

/**
 * §MONTH-STACK — how many categories a stacked bar can carry before it stops being readable.
 *
 * Everything past this is folded into one "other" segment. The cut is by the category's total
 * across the WHOLE window, never per month: a series whose segments change identity from bar to
 * bar is not comparable, which is the only reason to draw the months side by side.
 */
const STACK_CATEGORIES = 8;

export async function collectMonthlyHistory(env: Env, months: number): Promise<MonthlyHistory> {
  const analyticsRepo = await import("../../repo/analytics.ts");
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);   // always ₴ — the axis compares months with each other
  const now = Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -(months - 1));

  const loc = await resolveLocale(env);
  const [rows, imp, cats] = await Promise.all([
    analyticsRepo.monthlyHistory(env.DB, { mult }, now, from),
    // One extra grouped query rather than a second endpoint: it is the same months over the same
    // window, and two requests would let the halves answer for different periods.
    analyticsRepo.importanceByMonth(env.DB, { mult }, now, from),
    // §MONTH-STACK: the same window again, by category. One more grouped query rather than a
    // second endpoint, for the reason directly above — two requests could answer for two periods.
    analyticsRepo.categoryByMonth(env.DB, loc, { mult }, now, from),
  ]);

  // Rank by the window total, then keep the top N and fold the rest into one segment.
  const catTotal = new Map<string, { id: number | null; name: string; color: string | null; total: number }>();
  for (const r of cats) {
    const key = String(r.id ?? "none");
    const cur = catTotal.get(key) ?? {
      id: r.id, color: r.color,
      // A row with no category is real money (§MONTH-STACK) and needs a name a person can read.
      name: r.name ?? st(loc, "uncategorized"), total: 0,
    };
    cur.total += r.spent;
    catTotal.set(key, cur);
  }
  const ranked = [...catTotal.entries()].sort((a, b) => b[1].total - a[1].total);
  const keep = new Map(ranked.slice(0, STACK_CATEGORIES).map(([k, v]) => [k, v]));
  const hasOther = ranked.length > STACK_CATEGORIES;
  const stackKeys: MonthlyHistory["categories"] = [...keep.values()].map((v) => ({ id: v.id, name: v.name, color: v.color }));
  if (hasOther) stackKeys.push({ id: null, name: st(loc, "other"), color: null, other: true });

  const stackByMonth = new Map<string, Record<string, number>>();
  for (const r of cats) {
    const key = String(r.id ?? "none");
    const bucket = keep.has(key) ? key : "other";
    const m = stackByMonth.get(r.month) ?? {};
    m[bucket] = (m[bucket] ?? 0) + r.spent;
    stackByMonth.set(r.month, m);
  }

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
    const spend = r?.spend ?? 0, income = r?.income ?? 0;
    // The one number that says whether things are getting BETTER. A rising total is ambiguous —
    // a bigger rent and a bigger takeaway habit look identical in it — but the share of income
    // that survives the month is not.
    out.push({
      month: key, spend, income, savings_rate_pct: savingsRatePct(income, spend), ...w,
      by_category: stackByMonth.get(key) ?? {},
    });
  }
  return { months: out, categories: stackKeys };
}
