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
import { plannedActuals, plannedUAH, nextChargeUnix } from "../finance/subscriptions.ts";
import { localYmd } from "../finance/stats.ts";
import type { Draft } from "./notify.ts";

// The same one-liner every sibling drafter keeps (`drafts-due.ts`, `drafts-ai.ts`): a dedup key
// needs a Kyiv calendar day, and importing one another's private helper would couple files that
// otherwise share nothing.
const isoDay = (unix: number) => localYmd(unix);

/**
 * §PLAN-LATE — how long a scheduled payment may be late before the app says anything.
 *
 * Three days, and the number is the whole feature. The feed used to carry «Квартира відсутня в
 * цьому місяці — 12500 ₴ очікується 20 числа» on the 15th: a plan that was simply not due yet,
 * announced as an absence, five days early. Nothing about that was false and every word of it was
 * alarming, which is the specific way a feed loses its reader — the app crying about money that
 * has not gone anywhere.
 *
 * Why the grace exists at all rather than "the day after": a bank posts a payment a day late, a
 * weekend moves a transfer, and an enrichment links the charge to its plan on the next pass. Three
 * days is past all three, and it is still well inside the month the payment belongs to.
 */
const LATE_GRACE_DAYS = 3;
/**
 * A charge up to five days EARLY still counts as that period's payment: people pay rent before
 * the weekend, and a plan whose charge landed on the 18th for a due date of the 20th must not be
 * reported as missed on the 23rd.
 *
 * But the window may never reach back into the PREVIOUS cycle, so it is capped at half a period
 * (`earlyToleranceSec`). A weekly plan charges every 7 days: with a flat 5 days, a charge that was
 * merely 3 days late for due date A (inside `LATE_GRACE_DAYS`, so never reported) still sits
 * inside A+7's tolerance window and is read as ITS payment — and a weekly plan that genuinely
 * stopped stays silent for an extra cycle. Half a period is past every real "paid a few days
 * early" case and cannot touch the neighbour's.
 */
const EARLY_TOLERANCE_DAYS = 5;
const earlyToleranceSec = (periodSec: number) =>
  Math.min(EARLY_TOLERANCE_DAYS * 86400, Math.floor(periodSec / 2));

/**
 * The most recent scheduled date at or before `now`, or null when the plan has not been due yet.
 *
 * `nextChargeUnix` only answers forward, so the previous date is found by walking: from an anchor
 * comfortably in the past, step to each following charge while it is still behind us. Bounded by
 * construction — each step is one period — and it reuses the ONE implementation of «when does this
 * plan charge» (§SUB-DATE) instead of repeating month-end clamping and DST here.
 */
export function periodSeconds(period: string, count: number): number {
  return (period === "week" ? 7 : period === "year" ? 366 : 31) * 86400 * Math.max(1, count || 1);
}

export function lastDueUnix(
  start: number, period: string, count: number, now: number,
): number | null {
  const periodSec = periodSeconds(period, count);
  let due = nextChargeUnix(start, period, count, Math.max(start - 1, now - periodSec * 2));
  if (due > now) return null;
  for (let guard = 0; guard < 8; guard++) {
    const nxt = nextChargeUnix(start, period, count, due);
    if (nxt > now) break;
    due = nxt;
  }
  return due;
}

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
