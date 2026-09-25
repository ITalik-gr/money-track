/**
 * §SUB-STACK — the subscriptions as ONE thing you own, not a list of rows.
 *
 * Each subscription is small; the stack is not. What nobody notices is the total drifting — three
 * rows each «only» 20% dearer, one new service, one trial that quietly became a charge — while every
 * single card still looks fine. This module answers the questions ABOVE the rows:
 *   · what the stack costs per month and per year (§SUB-MONTH, the canon — nothing new);
 *   · what the plans actually TOOK per month over the last year, and how that moved (real charges,
 *     so a price rise §PLAN-REPRICE linked is in it even before the person accepts the new price);
 *   · which plans look like two of the same kind — a QUESTION, never an accusation;
 *   · which plans began as a trial and have just started charging in full.
 *
 * ⚠️ The amount never comes from a model. Everything here is arithmetic over linked charges and the
 * plans' own declared amounts; the §SUB-REVIEW judgment decides what IS a subscription, not what it
 * costs.
 */
import type { Env } from "../../env.ts";
import type { SubStack, StackTrial, StackDuplicate } from "../../../shared/api/planning.ts";
import type { Rates } from "./money.ts";
import * as planningRepo from "../../repo/planning.ts";
import { valueMode, localMonthStart, localYm, localYmSql } from "./stats.ts";
import { monthlyPlannedUAH, sumMonthlyPlannedUAH } from "./subscriptions.ts";
import { catNameSql } from "./categories-i18n.ts";
import { resolveLocale } from "../platform/i18n.ts";

/** Months of real charges the stack's history covers. A year: a yearly plan charges inside it once. */
const PAID_MONTHS = 12;
/** How many plans a month's tooltip names; the rest is «and N more». */
const STACK_TOP = 4;
/** Months averaged at each end of the history when measuring drift — one month is a coincidence. */
const DRIFT_EDGE = 3;
/** A trial is announced while it is fresh; after this it is simply the subscription. */
const TRIAL_FRESH_DAYS = 90;

/**
 * Trial → paid: the first linked charge was at most a tenth of what the plan charges since (a 0–1 ₴
 * card check, a 1 $ first month), and at least one full charge followed it. Pure, so the shape is
 * pinned by fixtures rather than guessed by a model.
 */
export function detectTrial(
  charges: { time: number; amount: number; currency_code: number }[],
): { trial_amount: number; trial_at: number; paid_amount: number; paid_since: number } | null {
  if (charges.length < 2) return null;
  const asc = [...charges].sort((a, b) => a.time - b.time);
  const [first, ...rest] = asc;
  const same = rest.filter((c) => c.currency_code === first.currency_code);
  if (!same.length) return null;
  const sorted = same.map((c) => c.amount).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0 || first.amount > median * 0.1) return null;
  return { trial_amount: first.amount, trial_at: first.time, paid_amount: median, paid_since: same[0].time };
}

/** Drift between the first and last `DRIFT_EDGE` months of a paid series, or null without both ends. */
export function stackDrift(series: { ym: string; paid: number }[]): SubStack["drift"] {
  if (series.length < DRIFT_EDGE * 2) return null;
  const avg = (xs: { paid: number }[]) => xs.reduce((s, x) => s + x.paid, 0) / xs.length;
  const from = avg(series.slice(0, DRIFT_EDGE));
  const to = avg(series.slice(-DRIFT_EDGE));
  if (from <= 0 || to <= 0) return null;
  return { from_avg: Math.round(from), to_avg: Math.round(to), pct: Math.round(((to - from) / from) * 100) };
}

export async function subscriptionStack(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<SubStack> {
  const { mult } = valueMode(rates, null);
  const loc = await resolveLocale(env);
  const monthStart = localMonthStart(now);
  const from = localMonthStart(now, -PAID_MONTHS);

  const [plans, paidRows, charges] = await Promise.all([
    planningRepo.activeWithCategory(env.DB),
    planningRepo.linkedPaidByMonth(env.DB, mult, localYmSql(now), from, monthStart),
    planningRepo.linkedChargesSince(env.DB, now - 400 * 86400),
  ]);
  // `monthly` and `count` cover EVERY outflow plan, installments included — the same set and the
  // same canon as the Subscriptions page hero (`monthly_base` summed over `kind <> 'income'`). Two
  // «per month» figures on one page that disagree is §CUR-PLAN's shape; the trims below are about
  // subscriptions only, because an installment ends on its own and is not a stack to prune.
  const monthly = sumMonthlyPlannedUAH(plans, rates, now);
  const subs = plans.filter((p) => (p.kind ?? "subscription") === "subscription");

  // A zero-filled year: a month with nothing linked is a real zero here (the plans existed and took
  // nothing), unlike income, where an empty ledger month is «unknown».
  // Per plan, then folded per month: the column's tooltip names what the month was MADE of (the
  // owner: «не дуже інформативно») — a total alone cannot say whether a tall month is a price rise
  // or an annual renewal.
  const byMonth = new Map<string, { paid: number; n: number; plans: { title: string; paid: number }[] }>();
  for (const r of paidRows) {
    const slot = byMonth.get(r.m) ?? { paid: 0, n: 0, plans: [] };
    slot.paid += r.paid; slot.n += r.n; slot.plans.push({ title: r.title, paid: r.paid });
    byMonth.set(r.m, slot);
  }
  const paid: SubStack["paid"] = [];
  for (let i = PAID_MONTHS; i >= 1; i--) {
    const ym = localYm(localMonthStart(now, -i));
    const slot = byMonth.get(ym);
    paid.push({
      ym, paid: slot?.paid ?? 0, n: slot?.n ?? 0,
      top: (slot?.plans ?? []).sort((a, b) => b.paid - a.paid).slice(0, STACK_TOP),
    });
  }
  // Leading months before the first linked charge are not «the stack cost nothing» — the ledger or
  // the plans had not started. Trim them so the drift compares months that were actually observed.
  const firstPaid = paid.findIndex((p) => p.paid > 0);
  const observed = firstPaid < 0 ? [] : paid.slice(firstPaid);

  // Two or more live subscriptions filed under the same LEAF category. Leaf, not root: «Розваги»
  // holds a cinema and a streaming service, and asking about those would be noise.
  const byCat = new Map<number, typeof subs>();
  for (const p of subs) {
    if (p.category_id == null || monthlyPlannedUAH(p, rates, now) <= 0) continue;
    const list = byCat.get(p.category_id) ?? [];
    list.push(p);
    byCat.set(p.category_id, list);
  }
  const dupCats = [...byCat.entries()].filter(([, l]) => l.length >= 2);
  const names = new Map<number, string>();
  if (dupCats.length) {
    const ids = dupCats.map(([id]) => id);
    const r = await env.DB.prepare(
      `SELECT id, ${catNameSql(loc, "name")} AS name FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all<{ id: number; name: string }>();
    for (const row of r.results ?? []) names.set(row.id, row.name);
  }
  const duplicates: StackDuplicate[] = dupCats.map(([id, l]) => ({
    category_id: id, category_name: names.get(id) ?? "",
    plans: l.map((p) => ({ id: p.id, title: p.title, monthly: monthlyPlannedUAH(p, rates, now) }))
      .sort((a, b) => b.monthly - a.monthly),
  }));

  const chargesByPlan = new Map<number, { time: number; amount: number; currency_code: number }[]>();
  for (const c of charges) {
    const list = chargesByPlan.get(c.planned_id) ?? [];
    list.push(c);
    chargesByPlan.set(c.planned_id, list);
  }
  const trials: StackTrial[] = [];
  for (const p of subs) {
    const tr = detectTrial(chargesByPlan.get(p.id) ?? []);
    if (tr && now - tr.paid_since <= TRIAL_FRESH_DAYS * 86400) {
      trials.push({ id: p.id, title: p.title, currency_code: p.currency_code ?? 980, ...tr });
    }
  }

  return {
    count: plans.length,
    monthly,
    paid: observed,
    drift: stackDrift(observed),
    duplicates,
    trials,
  };
}
