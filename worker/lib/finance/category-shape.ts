/**
 * §CAT-SHAPE (2026-09-02) — the three questions a category page could not answer.
 *
 * The page already says HOW MUCH (level, trend, composition, merchants, avg cheque, year-ago).
 * What it had no answer for is the three the owner picked out of the backlog, and they are one
 * family: not the size of a category, but its SHAPE.
 *
 *   · **How much of it is obligatory** (§6 importance, inside one category). Stats answers this
 *     for the whole ledger — «45% of everything is essential», which is true and unactionable,
 *     because a category is the level a person can actually change. Asked of Транспорт it becomes
 *     a decision: two thirds is the commute, the rest is taxis.
 *   · **When the money leaves** — weekday for a category charged many small times, day-of-month
 *     for one charged few big times. Both come from `weekday.ts`, the canon that already owns
 *     §WEEKDAY, so a category chart cannot disagree with the global one about the same money.
 *   · **Where the month ends up** — `projectSpend`, the same projection the envelope uses.
 *
 * ⚠️ **A SHAPE NEEDS A SAMPLE, and this is where a category page differs from the Stats page.**
 * The ledger has thousands of rows; one category may have nine. Seven weekday buckets built from
 * nine charges is not a weekly rhythm, it is nine charges drawn as a bar chart — and the reader
 * cannot tell the difference, because the chart looks identical either way. So each half is
 * withheld until it has something to stand on, and the gate is stated in buckets rather than
 * picked as a round number: a claim about N buckets needs at least `MIN_PER_BUCKET` observations
 * per bucket on average, or it is describing individual purchases.
 *
 * ⚠️ **The day-of-month half is NOT a 31-cell heat map here.** The Trends tab has one, and it
 * earns its space over the whole ledger. Inside a category the useful fact is a sentence — «майже
 * все йде 1-го числа», «половина місяця витрачається за перші пʼять днів» — and 31 cells of which
 * 27 are empty says that worse than the sentence does, while taking twenty times the room.
 *
 * ⚠️ **The projection lives only where the LEVEL lives** — a top-level expense category, current
 * month. That is the §CAT-PAGE rule verbatim: `categoryMonthlyLevels` rolls up, so for a
 * sub-category it would be a number about a DIFFERENT category, and for income it means nothing.
 */
import type { Env } from "../../env.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import type { CatScope } from "../../repo/categories.ts";
import { buildWeekdayAnalytics, buildDomAnalytics } from "./weekday.ts";
import { categoryMonthlyLevels, projectSpend, localMonthStart, localDayStart } from "./stats.ts";
import type { CategoryShape } from "../../../shared/api/analytics.ts";

/**
 * The evidence a bucketed shape needs, per bucket, before it is drawn.
 *
 * Two, not one. One observation per bucket is a list of purchases with a bar behind each; two is
 * the smallest number at which "this weekday is different from that one" can mean anything at all.
 * It is deliberately not higher: a category with 14 charges in a month DOES have a weekly rhythm
 * worth seeing, and demanding a statistician's sample would hide the shape on every category
 * except groceries.
 */
const MIN_PER_BUCKET = 2;

/** Seven weekdays, so a weekly shape starts at 14 charges in the window. */
const WEEKDAY_BUCKETS = 7;

/**
 * The day-of-month claim is about CONCENTRATION, not about 31 separate figures, so it needs less
 * than a heat map would — but it still needs more than one month, or "everything happens on the
 * 3rd" is just "there was one charge".
 */
const MIN_DOM_MONTHS = 2;

/** How much of a month must have passed before a projection is worth stating. The envelope uses
 *  the same idea; a projection made on the 1st is the level with extra steps. */
const MIN_ELAPSED_FRAC = 0.15;

export async function categoryShape(
  env: Env, mult: string, scope: CatScope, from: number, to: number, now: number,
): Promise<CategoryShape> {
  const [wdRows, domRows, impRows] = await Promise.all([
    categoriesRepo.weekdayFor(env.DB, mult, scope, from, to, now),
    categoriesRepo.domFor(env.DB, mult, scope, from, to, now),
    // Importance is a property of a SPEND row. An income bucket has none, and asking would put
    // every salary in `discretionary` — the COALESCE chain's default — which reads as a claim.
    scope.isIncome ? Promise.resolve([]) : categoriesRepo.importanceFor(env.DB, mult, scope, from, to),
  ]);

  const n = wdRows.reduce((sum, r) => sum + r.n, 0);
  const spent = wdRows.reduce((sum, r) => sum + r.spent, 0);
  // The largest single charge in the window. Max over the weekday buckets IS the max over the
  // window, and taking it from rows already fetched avoids a fourth query for one number.
  const biggest = wdRows.reduce((max, r) => Math.max(max, r.biggest), 0);

  // ---- when the money leaves ------------------------------------------------------------------
  const weekday = n >= WEEKDAY_BUCKETS * MIN_PER_BUCKET
    ? buildWeekdayAnalytics(wdRows, from, to)
    : null;

  const monthsInWindow = (to - from) / (30 * 86400);
  const domFull = buildDomAnalytics(domRows, from, to);
  // The busiest DATE, with the evidence behind it, rather than the whole 31-cell row: a category
  // page has room for a sentence and the Trends tab already owns the map.
  const busiestDay = domFull.busiest != null ? domFull.days[domFull.busiest - 1] : undefined;
  const dom = monthsInWindow >= MIN_DOM_MONTHS && n >= MIN_PER_BUCKET
    ? {
      busiest: domFull.busiest,
      busiest_typical: busiestDay?.typical ?? 0,
      busiest_n: busiestDay?.n ?? 0,
      first_five_share_pct: domFull.first_five_share_pct,
    }
    : null;

  // ---- how much of it is obligatory ------------------------------------------------------------
  // Shares are of the parts' own sum, so they add to 100 and agree with the category total —
  // the same guarantee §CAT-PARTS makes about composition.
  const impTotal = impRows.reduce((sum, r) => sum + Math.abs(r.spent), 0);
  const importance = impRows.length
    ? impRows
      .filter((r) => r.spent !== 0)
      .map((r) => ({
        level: r.importance,
        spent: Math.abs(r.spent),
        n: r.n,
        share_pct: impTotal > 0 ? Math.round((Math.abs(r.spent) / impTotal) * 100) : 0,
      }))
      .sort((a, b) => b.spent - a.spent)
    : null;

  // ---- where the month ends up -------------------------------------------------------------
  const monthStart = localMonthStart(now);
  // Only for the CURRENT month, and only for a category whose canonical level exists. Projecting a
  // window the reader widened to a year would be a sentence about a period that is already over.
  const isThisMonth = from === monthStart && to >= localDayStart(now);
  let projection: CategoryShape["projection"] = null;
  if (isThisMonth && scope.isParent && !scope.isIncome) {
    const lv = (await categoryMonthlyLevels(env, mult, { now })).get(scope.id);
    const monthEnd = localMonthStart(now, 1);
    const elapsedFrac = (now - monthStart) / (monthEnd - monthStart);
    if (lv && lv.level > 0 && elapsedFrac >= MIN_ELAPSED_FRAC) {
      /**
       * The lump rule, COPIED FROM NOWHERE — it is the one `budgets.ts` and the pace radar already
       * use, spelled the same way. Spending concentrated in one or two large operations (tax,
       * rent, a tank of fuel) is a fact that has already happened, not a rate to multiply by the
       * days left; a fixed cost not yet charged this month is the mirror case, nothing to
       * extrapolate from but the money is still coming. `projectSpend` refuses to extrapolate
       * either — which is the whole reason to call it rather than divide by `elapsedFrac`.
       */
      const lumpy = (spent > 0 && (n <= 1 || biggest >= spent * 0.55)) || (spent === 0 && !!lv.fixed);
      projection = {
        spent,
        projected: projectSpend(spent, lv.level, elapsedFrac, lumpy),
        usual: lv.level,
        lumpy,
        elapsed_pct: Math.round(elapsedFrac * 100),
      };
    }
  }

  return { from, to, n, weekday, dom, importance, projection };
}
