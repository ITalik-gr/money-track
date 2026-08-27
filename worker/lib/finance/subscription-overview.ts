/**
 * §SUB-PAGE (2026-08-27) — one subscription, answered the way the category page answers a category.
 *
 * A plan used to be a row on a list: a name, an amount, a next date. The questions a person
 * actually has about a subscription are none of those, and the app could answer none of them:
 *   • how much has this ALREADY cost me — the number that decides whether to keep it;
 *   • has it got more expensive — visible only by comparing charges over time;
 *   • is it billed as often as I think — a "monthly" plan charging every 14 days is a real thing
 *     and nothing here would have shown it;
 *   • what does it cost me a YEAR;
 *   • how big is it next to my other subscriptions, next to its own category, next to everything
 *     I spend — the only way an amount becomes a decision.
 *
 * Every figure comes from the canon: `monthlyPlannedUAH` for the burden (§SUB-MONTH),
 * `categoryMonthlyLevels`/`sumLevels` for the shares, `nextChargeUnix` for the date. Nothing here
 * recomputes a number that already has a home — the page and the Advisor must not be able to
 * disagree about the same subscription.
 */
import type { Env } from "../../env.ts";
import type { SubscriptionOverview } from "../../../shared/api/planning.ts";
import * as planningRepo from "../../repo/planning.ts";
import { getRates } from "./money.ts";
import { valueMode, categoryMonthlyLevels, sumLevels } from "./stats.ts";
import { catNameSql } from "./categories-i18n.ts";
import { nextChargeUnix, monthlyPlannedUAH, sumMonthlyPlannedUAH } from "./subscriptions.ts";
import { chargeRhythm } from "./recurring.ts";
import { resolveLocale } from "../platform/i18n.ts";

/**
 * §PRICE-STEPS — the distinct prices this plan has actually been billed at, oldest first.
 *
 * "Has it got more expensive" was answered by ONE comparison: the latest charge against the
 * declared amount. That says whether it is expensive TODAY and nothing about when it moved, which
 * is the half a person needs to decide whether to keep it. A run of charges at the same price is
 * one step; the step's `since` is the first charge at that price.
 *
 * ⚠️ Grouped with the SAME ±10% tolerance as `amountMatches` and §SUB-DETECT's buckets: the plan
 * is linked to these charges by that tolerance, so treating a 2 ₴ FX wobble as a price rise here
 * would contradict the rule that attached the charge in the first place.
 * ⚠️ Compared only WITHIN one currency. A biller that switched from dollars to hryvnia did not
 * raise its price by 4 000%.
 */
const STEP_TOLERANCE = 0.1;

function priceSteps(charges: { time: number; amount: number; currency_code: number }[]) {
  const asc = [...charges].sort((a, b) => a.time - b.time);
  const out: { amount: number; currency_code: number; since: number; n: number }[] = [];
  for (const c of asc) {
    const last = out[out.length - 1];
    const same = last && last.currency_code === c.currency_code
      && Math.abs(c.amount - last.amount) <= last.amount * STEP_TOLERANCE;
    if (same) { last.n++; continue; }
    out.push({ amount: c.amount, currency_code: c.currency_code, since: c.time, n: 1 });
  }
  return out;
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

export async function subscriptionOverview(
  env: Env, id: number, now = Math.floor(Date.now() / 1000),
): Promise<SubscriptionOverview | null> {
  const plan = await planningRepo.byId(env.DB, id);
  if (!plan) return null;

  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const loc = await resolveLocale(env);

  const [charges, totals, levels, allPlans, cat] = await Promise.all([
    planningRepo.planCharges(env.DB, id, mult),
    planningRepo.planTotals(env.DB, id, mult),
    categoryMonthlyLevels(env, mult, { now }),
    planningRepo.activeWithCategory(env.DB),
    plan.category_id == null ? Promise.resolve(null) : env.DB.prepare(
      `SELECT ${catNameSql(loc, "name")} AS name FROM categories WHERE id = ?`,
    ).bind(plan.category_id).first<{ name: string }>(),
  ]);

  const monthlyBase = monthlyPlannedUAH(plan, rates, now);
  const subsMonthly = sumMonthlyPlannedUAH(allPlans, rates, now);
  const burn = sumLevels(levels);
  const categoryMonthly = plan.category_id == null ? null : levels.get(plan.category_id)?.level ?? null;

  // ⚠️ The REAL cadence, measured between the charges that actually happened — not the declared
  // one. "Monthly" is what the plan says; a biller charging every 14 days, or one that stopped
  // charging in March, is exactly what this page exists to make visible.
  //
  // ⚠️ §RHYTHM: through the canon, which is the MEDIAN gap. This used to be
  // `(last − first) / (n − 1)` right here — a mean, and one missing charge destroys it. Real case:
  // Apple bills on the 6th of every month, five charges in the ledger, four linked to the plan;
  // the page announced «кожні ~41 дн» and warned that the rhythm had drifted. Both were one
  // missing row. The same function now answers this and §SUB-DETECT, so the page and the
  // "we found a subscription" proposal cannot disagree about the same series.
  const times = charges.map((c) => c.time).sort((a, b) => a - b);
  const rhythm = chargeRhythm(times);
  const realInterval = rhythm.interval_days;
  const declaredInterval = Math.round(
    (plan.period === "week" ? 7 : 30.44) * Math.max(1, plan.period_count ?? 1),
  );

  // The price the biller last took against the price the plan declares. Both in the PLAN's own
  // currency, because that is the pair the person compares — an FX move is not a price rise.
  const last = charges[0] ?? null;
  const comparable = last && last.currency_code === plan.currency_code ? last.amount : null;
  const priceChangePct = comparable != null && plan.period_amount
    ? Math.round(((comparable - plan.period_amount) / plan.period_amount) * 100)
    : null;

  return {
    plan: {
      id: plan.id, title: plan.title, kind: plan.kind ?? "subscription",
      period: plan.period, period_count: plan.period_count ?? 1,
      period_amount: plan.period_amount, currency_code: plan.currency_code ?? 980,
      category_id: plan.category_id ?? null, category_name: cat?.name ?? null,
      note: plan.note ?? null, start_date: plan.start_date, end_date: plan.end_date ?? null,
      is_active: !!plan.is_active, monthly_base: monthlyBase,
    },
    // A finished plan has no next charge — an instalment that ended, or a cancelled subscription.
    // Printing the date it WOULD have fallen on is the app arguing with a decision already made.
    next_charge: !plan.is_active || (plan.end_date != null && plan.end_date <= now) ? null : (() => {
      const at = nextChargeUnix(plan.start_date, plan.period, plan.period_count ?? 1, now);
      return { at, in_days: Math.max(0, Math.round((at - now) / 86400)) };
    })(),
    actual: {
      n: totals.n,
      first_time: totals.first_time, last_time: totals.last_time,
      total_base: totals.total_base,
      avg_base: totals.n > 0 ? Math.round(totals.total_base / totals.n) : null,
      last_amount: last?.amount ?? null, last_currency: last?.currency_code ?? null,
      price_change_pct: priceChangePct,
      real_interval_days: realInterval, declared_interval_days: declaredInterval,
      billing_day: rhythm.day_of_month, skipped_gaps: rhythm.skipped,
    },
    price_steps: priceSteps(charges),
    charges,
    share: {
      of_subscriptions_pct: pct(monthlyBase, subsMonthly),
      of_category_pct: categoryMonthly ? pct(monthlyBase, categoryMonthly) : null,
      of_burn_pct: pct(monthlyBase, burn),
    },
    annual_base: monthlyBase * 12,
    category_monthly_base: categoryMonthly,
  };
}
