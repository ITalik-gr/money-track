/**
 * `drafts-plans` — WHAT CHANGED ABOUT A PLAN the user already declared: a subscription whose price
 * moved (§PRICE-STEPS), one that has stopped being charged at all, and one whose date went by with
 * no charge behind it (§PLAN-LATE).
 *
 * Split out of `notify.ts` on 2026-09-18 under lint C3, the same way `drafts-due.ts` was split the
 * week before: that file sits at its size exception, an exception may never RISE, and a new
 * notification kind had nowhere to land. The seam is a real one rather than a slice of whatever
 * was at the bottom of the file — both drafters here read `plannedActuals()` against
 * `planned_payments` and both answer «the plan you declared and the charges we see disagree»,
 * which is a different question from «money leaves on a date» (`drafts-due`) and from «your month
 * is going badly» (the pace drafters that stayed behind).
 *
 * They keep SEPARATE preferences (`price_up`, `dead_sub`, `plan_missed`) because they are separate
 * facts: one costs money, one saves it, and one says a payment you counted on has not happened —
 * muting «this got more expensive» says nothing about wanting to hear the other two.
 */
import type { Env } from "../../env.ts";
import { getRates } from "../finance/money.ts";
import { plannedActuals, plannedUAH } from "../finance/subscriptions.ts";
import {
  lastDueUnix, periodSeconds, earlyToleranceSec, LATE_GRACE_DAYS,
} from "../finance/plan-state.ts";
import { linkPlanHistoryById } from "../finance/plan-match.ts";
import { localYmd } from "../finance/stats.ts";
import type { Draft } from "./notify.ts";

// The same one-liner every sibling drafter keeps (`drafts-due.ts`, `drafts-ai.ts`): a dedup key
// needs a Kyiv calendar day, and importing one another's private helper would couple files that
// otherwise share nothing.
const isoDay = (unix: number) => localYmd(unix);

// §PLAN-LATE's windows (the 3-day grace, the half-period early tolerance) and the backward walk
// `lastDueUnix` moved to `finance/plan-state.ts` on 2026-09-25, so the subscription card can ask the
// same question the feed asks — «did the last cycle land» — with the same answer. Re-exported for
// the tests that pinned them here.
export { lastDueUnix, periodSeconds } from "../finance/plan-state.ts";

/**
 * §PLAN-LATE: a plan whose date has passed by more than the grace period with no charge linked.
 *
 * Only plans that HAVE a history (`count > 0`): one that never charged at all is `dead_sub`'s
 * story, told once a month, and two cards about the same silent plan is the repetition the feed
 * spends most of its code avoiding.
 */
export async function draftMissedPlans(env: Env, now: number): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare(
      // An instalment plan that has run its course is not late, it is over (`end_date`).
      `SELECT id, title, period, period_count, start_date, period_amount, currency_code
       FROM planned_payments WHERE is_active = 1 AND (end_date IS NULL OR end_date > ?)`,
    ).bind(now).all<{
      id: number; title: string; period: string; period_count: number | null;
      start_date: number; period_amount: number | null; currency_code: number | null;
    }>(),
  ]);
  const rates = await getRates(env);
  const byId = new Map(actuals.map((a) => [a.id, a]));

  const out: Draft[] = [];
  for (const p of plans.results ?? []) {
    const a = byId.get(p.id);
    if (!a || a.count === 0) continue;                       // §dead_sub owns the never-charged case
    const due = lastDueUnix(p.start_date, p.period, p.period_count ?? 1, now);
    if (due == null) continue;
    const lateDays = Math.floor((now - due) / 86400);
    if (lateDays < LATE_GRACE_DAYS) continue;                // not late yet — say nothing
    const early = earlyToleranceSec(periodSeconds(p.period, p.period_count ?? 1));
    if (a.last_time != null && a.last_time >= due - early) continue;                        // paid
    if (await paidOnSecondLook(env, p.id, due - early)) continue;                          // paid, unlinked
    out.push({
      kind: "plan_missed",
      tkey: "plan_missed",
      tparams: {
        title: p.title,
        amount: plannedUAH(p.period_amount, p.currency_code, rates),
        due, days: lateDays,
      },
      severity: "warn",
      entity_type: "planned", entity_id: String(p.id),
      // Once per plan per expected DATE: the charge is still missing tomorrow, and repeating the
      // card every morning is how the feed turns into wallpaper.
      dedup_key: `plan_missed:${p.id}:${isoDay(due)}`,
    });
  }
  return out.slice(0, 3);
}

/**
 * Before saying a payment did not happen, look once more — and link what is found.
 *
 * «Not linked» and «not paid» are different facts, and this card only has the right to state the
 * second. The first had several ways in: an ingest path that skipped matching (learned aliases did,
 * until 2026-09-21 — the feed announced missed Київстар and EasyPay bills paid on the 2nd and 3rd),
 * a CSV import, an operation added by hand. `linkPlanHistory` is the same matcher the plan runs
 * when it is created, idempotent, and it only ever fills a NULL `planned_id` — so running it for the
 * one or two plans that look late costs a query each and heals the history for every other screen.
 */
async function paidOnSecondLook(env: Env, planId: number, since: number): Promise<boolean> {
  await linkPlanHistoryById(env.DB, planId);
  const r = await env.DB.prepare(
    "SELECT MAX(time) AS t FROM transactions WHERE planned_id = ? AND amount < 0 AND is_transfer = 0",
  ).bind(planId).first<{ t: number | null }>();
  return r?.t != null && r.t >= since;
}

/** Подорожчання підписки: остання фактична сума помітно вища за план (plannedActuals). */
export async function draftPriceUps(env: Env): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare("SELECT id, title, period_amount FROM planned_payments WHERE is_active = 1")
      .all<{ id: number; title: string; period_amount: number | null }>(),
  ]);
  const titleById = new Map((plans.results ?? []).map((p) => [p.id, p]));

  const out: Draft[] = [];
  for (const a of actuals) {
    if (a.price_change_pct == null || a.price_change_pct < 10) continue;
    const p = titleById.get(a.id);
    if (!p || !p.period_amount || a.last_amount == null || a.last_time == null) continue;
    const delta = a.last_amount - p.period_amount;
    if (delta <= 0) continue;
    out.push({
      kind: "price_up",
      // Абсолютна дельта + вплив на рік читається краще за голий відсоток (як у Підписках).
      tkey: "price_up",
      tparams: {
        title: p.title, pct: a.price_change_pct,
        old: p.period_amount, new: a.last_amount, delta, year: delta * 12,
      },
      severity: "warn",
      entity_type: "planned", entity_id: String(a.id),
      dedup_key: `price_up:${a.id}:${isoDay(a.last_time)}`,
    });
  }
  return out;
}

/** «Мертва» підписка: активна понад 60 днів, а жодного фактичного списання не видно. */
export async function draftDeadSubs(env: Env, now: number): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare(
      "SELECT id, title, period_amount, currency_code, start_date FROM planned_payments WHERE is_active = 1",
    ).all<{ id: number; title: string; period_amount: number | null; currency_code: number | null; start_date: number }>(),
  ]);
  const rates = await getRates(env);
  const countById = new Map(actuals.map((a) => [a.id, a.count]));

  const out: Draft[] = [];
  for (const p of plans.results ?? []) {
    if (now - p.start_date < 60 * 86400) continue;   // ще молода — рано судити
    if ((countById.get(p.id) ?? 0) > 0) continue;    // списання бачимо
    const perMonth = plannedUAH(p.period_amount, p.currency_code, rates);
    out.push({
      kind: "dead_sub",
      tkey: "dead_sub",
      tparams: { title: p.title, perMonth },
      severity: "info",
      entity_type: "planned", entity_id: String(p.id),
      dedup_key: `dead_sub:${p.id}:${isoDay(now).slice(0, 7)}`,   // раз на місяць
    });
  }
  return out.slice(0, 3);
}
