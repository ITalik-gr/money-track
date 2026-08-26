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
import { resolveLocale } from "../platform/i18n.ts";

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
  const times = charges.map((c) => c.time).sort((a, b) => a - b);
  const realInterval = times.length > 1
    ? Math.round((times[times.length - 1] - times[0]) / (times.length - 1) / 86400)
    : null;
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
    },
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
