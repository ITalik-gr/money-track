// §HABITS — what QUIETLY joined your regular spending, and what quietly stopped.
//
// The gap this fills: every other screen answers "how much" and "on what" for a period. None
// answers "what changed about the SET of things you pay for". People do not notice acquiring a
// subscription — they notice the total, months later, and cannot say which month it started.
// Symmetrically, a payment going silent is worth surfacing: either it was cancelled on purpose
// (fine, dismiss it) or a standing order failed and nobody noticed.
//
// Deliberately NOT the same thing as `planned_payments`: those are the plans the user DECLARED.
// This looks at what the bank actually did, so it finds the ones never declared — which is the
// entire point, since an undeclared recurring charge is the one nobody is tracking.
import { localYm, localMonthStart, valueMode } from "./stats.ts";
import { getRates } from "./finance.ts";
import type { Env } from "../../env.ts";
import type { HabitChange, Habits } from "../../../shared/api/analytics.ts";

/**
 * The whole feature, assembled: window, canon conversion, and the merchants already answered for.
 *
 * Lives here rather than in the route because all three are decisions ABOUT habits — the same rule
 * that keeps AI feature logic out of `ai.ts`. The route is left with one line, which is what a
 * route should be.
 *
 * The window is 9 COMPLETE months; the current one is excluded everywhere inside `buildHabits`,
 * because half a month of data looks exactly like a merchant that stopped.
 */
export async function collectHabits(env: Env, now: number): Promise<Habits> {
  const analyticsRepo = await import("../../repo/analytics.ts");
  const planningRepo = await import("../../repo/planning.ts");
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);   // always UAH — the lists compare merchants with each other
  const from = localMonthStart(now, -9);
  const [rows, declared, dismissed] = await Promise.all([
    analyticsRepo.merchantMonths(env.DB, { mult, curFilter: "" }, { from, to: now }, now),
    // Merchants the user has already answered for: a declared plan, or "this is not a
    // subscription". Without this the row would stay in the list AFTER its own action — the click
    // would look like it did nothing, which is worse than having no button at all.
    planningRepo.declaredTitles(env.DB),
    planningRepo.dismissedMerchants(env.DB),
  ]);
  return buildHabits(rows, now, new Set([...declared, ...dismissed]));
}

/** One merchant's spend in one calendar month, from `repo/analytics.ts`. */
export interface MerchantMonthRow { merchant: string; ym: string; spent: number; n: number }

/**
 * Split a merchant's monthly history into "newly regular" and "gone quiet".
 *
 * The thresholds, and why each is what it is:
 *
 *  • **A newcomer needs ≥2 of the last 3 complete months, and 0 in the 3 before them.** Two hits
 *    rather than one, because one purchase is a purchase; two months apart is a pattern. Complete
 *    months only — the current partial month would make every merchant look like it just stopped.
 *  • **A dormant one needs ≥3 of the 6 prior months and 0 in the last 2 complete ones.** Three
 *    establishes it was regular; two months of silence is longer than any monthly billing cycle,
 *    so it is not just a late charge.
 *
 * `monthly` is the average over the months it was actually charged — not over the window, which
 * would understate a merchant that started recently. That is the same reasoning as `typical` in
 * §WEEKDAY: divide by the periods that could have contained it, not by the calendar.
 *
 * `known` (lower-cased) drops merchants the user has already answered for — a declared plan, or a
 * row dismissed with "this is not a subscription". It applies to BOTH lists, and the second one
 * is the less obvious half: a declared plan that goes silent is worth saying, but `dead_sub` in
 * `notify.ts` already says it. Two features reporting the same fact in different words is how a
 * user learns to distrust both.
 */
export function buildHabits(rows: MerchantMonthRow[], now: number, known: Set<string> = new Set()): Habits {
  // Complete months only, newest first: [last complete, one before, …]. The current month is
  // excluded everywhere — half a month of data looks exactly like a merchant going quiet.
  const months: string[] = [];
  for (let i = 1; i <= 9; i++) months.push(localYm(localMonthStart(now, -i)));

  const recent3 = new Set(months.slice(0, 3));
  const prior3 = new Set(months.slice(3, 6));
  const quiet2 = new Set(months.slice(0, 2));
  const prior6 = new Set(months.slice(2, 8));

  const byMerchant = new Map<string, MerchantMonthRow[]>();
  for (const r of rows) (byMerchant.get(r.merchant) ?? byMerchant.set(r.merchant, []).get(r.merchant)!).push(r);

  const started: HabitChange[] = [];
  const stopped: HabitChange[] = [];

  for (const [merchant, hist] of byMerchant) {
    // Already answered for — declared as a plan or dismissed. Filtered here rather than in SQL so
    // the rule sits next to the thresholds it qualifies, and so the tests can state it.
    if (known.has(merchant.toLowerCase())) continue;
    const hit = (set: Set<string>) => hist.filter((h) => set.has(h.ym));

    const inRecent = hit(recent3);
    if (inRecent.length >= 2 && hit(prior3).length === 0) {
      started.push({
        merchant,
        months: inRecent.length,
        monthly: Math.round(inRecent.reduce((s, h) => s + h.spent, 0) / inRecent.length),
        since: inRecent.reduce((min, h) => (h.ym < min ? h.ym : min), inRecent[0]!.ym),
        last: inRecent.reduce((max, h) => (h.ym > max ? h.ym : max), inRecent[0]!.ym),
      });
      continue; // a merchant cannot be both; a newcomer that already stopped is just noise
    }

    const wasRegular = hit(prior6);
    if (wasRegular.length >= 3 && hit(quiet2).length === 0) {
      stopped.push({
        merchant,
        months: wasRegular.length,
        monthly: Math.round(wasRegular.reduce((s, h) => s + h.spent, 0) / wasRegular.length),
        since: wasRegular.reduce((min, h) => (h.ym < min ? h.ym : min), wasRegular[0]!.ym),
        last: wasRegular.reduce((max, h) => (h.ym > max ? h.ym : max), wasRegular[0]!.ym),
      });
    }
  }

  // Biggest first: the list is meant to be read from the top and abandoned, not scrolled.
  const bySize = (a: HabitChange, b: HabitChange) => b.monthly - a.monthly;
  return {
    started: started.sort(bySize).slice(0, 6),
    stopped: stopped.sort(bySize).slice(0, 6),
    // What the newcomers add up to per month — the number that answers "so what".
    started_monthly_total: started.reduce((s, h) => s + h.monthly, 0),
  };
}
