/**
 * §PLAN-STATE — WHEN a plan charges, and what happened to the cycle that just went by.
 *
 * Split out on 2026-09-25. The schedule used to live in two places for two readers:
 * `nextChargeUnix` in `subscriptions.ts` (forward: «when is the next one») and `lastDueUnix` with
 * the §PLAN-LATE tolerances in `messaging/drafts-plans.ts` (backward: «did the last one land»). The
 * backward half was reachable only from the feed, so the subscription card — which only ever asked
 * forward — could not tell a paid plan from one whose charge had gone missing. The owner's YouTube
 * is the case: 100 → 179 ₴, the charge was not linked, and the card announced next month's date
 * for a plan whose present it had missed.
 *
 * Why a new file rather than one more import edge: `subscriptions.ts` re-exports `plan-match.ts`,
 * and `plan-match` now needs the cycle window (§PLAN-REPRICE). `plan-match → subscriptions` would
 * close a cycle; with the schedule living here the arrows run one way — `subscriptions → plan-state`,
 * `plan-match → plan-state`, `drafts-plans → plan-state` — and every old import still resolves
 * through a re-export, so there is still exactly one definition of each name.
 *
 * No database here. Everything is a function of a plan's schedule and the charges already linked.
 */
import type { PlanState } from "../../../shared/api/planning.ts";
import { localParts, localWallTime } from "./time.ts";

const DAY = 86400;

function daysInMonth(y: number, mIndex: number): number {
  return new Date(Date.UTC(y, mIndex + 1, 0)).getUTCDate();
}

// §SUB4 канонічне «наступне списання»: від start_date крокуємо періодом × period_count
// у майбутнє. ЄДИНЕ джерело для воркера (ендпоінти/proactive) — дзеркалиться фронтовим
// Subscriptions.nextCharge. Раніше частина ендпоінтів ігнорувала period_count, тож
// квартальна підписка помилково «спливала» щомісяця.
export function nextChargeUnix(startDate: number, period: string, count = 1, now = Math.floor(Date.now() / 1000)): number {
  const n = Math.max(1, Math.round(count || 1));
  if (period === "week") { let t = startDate; while (t <= now) t += 7 * DAY * n; return t; }

  // ⚠️ Every charge is counted from the START, not from the previous one (2026-08-27). The old
  // implementation stepped a `Date` with `setMonth(+1)`, and JavaScript resolves 31 February by
  // ROLLING OVER: a plan starting on the 31st went 31 Jan → 3 Mar → 3 Apr, skipping February
  // outright and then charging on the 3rd for the rest of its life. A subscription whose date
  // quietly moves is worse than one that is late — it lands in a different budget month, and the
  // charge that "disappeared" is the one nobody goes looking for.
  // ⚠️ The anchor is the KYIV day (§APP_TZ): a charge at 01:00 Kyiv on the 20th is the 19th in UTC,
  // and reading it as the 19th would move every schedule a day earlier than the person's calendar.
  const p = localParts(startDate);
  // Start the scan near `now` rather than at the plan's birth: a plan from 2019 would otherwise
  // cost ~80 timezone resolutions per call, and `chargesBetween` calls this in a loop.
  const q = localParts(Math.max(now, startDate));
  let k = Math.max(0, Math.floor((((q.y - p.y) * 12 + (q.m - p.m)) - n) / n) * n);
  for (let guard = 0; guard < 600; guard++, k += n) {
    const mi = (p.m - 1) + k;                       // months since January of the start's year
    const y = p.y + Math.floor(mi / 12);
    const m0 = ((mi % 12) + 12) % 12;               // 0-based, for `daysInMonth`
    // Clamp, never roll over: the 31st of a 30-day month is that month's LAST day, which is what
    // every biller in the world does.
    // `localWallTime` rather than midnight + seconds: on the day the clocks change there are 23 or
    // 25 hours, and adding a time-of-day to midnight moves the charge by one (§APP_TZ).
    const t = localWallTime(y, m0 + 1, Math.min(p.d, daysInMonth(y, m0)), p.hh, p.mm, p.ss);
    if (t > now) return t;
  }
  return startDate;
}

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
export const LATE_GRACE_DAYS = 3;
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
export const EARLY_TOLERANCE_DAYS = 5;
export const earlyToleranceSec = (periodSec: number) =>
  Math.min(EARLY_TOLERANCE_DAYS * DAY, Math.floor(periodSec / 2));

export function periodSeconds(period: string, count: number): number {
  return (period === "week" ? 7 : period === "year" ? 366 : 31) * DAY * Math.max(1, count || 1);
}

/**
 * The most recent scheduled date at or before `now`, or null when the plan has not been due yet.
 *
 * `nextChargeUnix` only answers forward, so the previous date is found by walking: from an anchor
 * comfortably in the past, step to each following charge while it is still behind us. Bounded by
 * construction — each step is one period — and it reuses the ONE implementation of «when does this
 * plan charge» (§SUB-DATE) instead of repeating month-end clamping and DST here.
 */
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
 * The plan's DECLARED cycle in days — «monthly» as a biller means it, not 31 days flat.
 *
 * `periodSeconds` rounds a month UP to 31 on purpose (it bounds a walk and must never undershoot).
 * A tolerance measured against a real gap needs the average instead, or a February gap reads as
 * three days short of its cycle.
 */
export function declaredIntervalDays(period: string, count: number): number {
  return (period === "week" ? 7 : period === "year" ? 365.25 : 30.44) * Math.max(1, count || 1);
}

/** How many consecutive cycles a missing-charge walk looks back. Past this it is simply `stopped`. */
const MAX_MISSED_WALK = 4;

/** The price tolerance a charge is still "the declared price" within — the same ±10% as `amountMatches`. */
const PRICE_TOLERANCE = 0.1;

export interface PlanScheduleLike {
  start_date: number;
  period: string;
  period_count?: number | null;
  end_date?: number | null;
  is_active?: number | boolean | null;
  period_amount: number | null;
  currency_code?: number | null;
}

/** A charge linked to the plan: `amount` POSITIVE, in the charge's own currency. */
export interface LinkedCharge { time: number; amount: number; currency_code: number | null }

/**
 * §PLAN-STATE — what happened to the plan's latest cycle. See `PlanState` in `shared/api/planning.ts`
 * for what each kind means to a reader.
 *
 * The windows are §PLAN-LATE's, unchanged: a cycle is settled by a charge from `due − early` on,
 * and nothing is said until `LATE_GRACE_DAYS` after the due date. The feed's `plan_missed` card
 * and this state therefore cannot disagree about whether a payment is late.
 *
 * ⚠️ Cycles BEFORE the first linked charge are never counted as missed. A plan is usually created
 * long after the subscription began, and the ledger may not reach back that far — a cycle the app
 * cannot see is not a cycle the biller skipped.
 */
export function planState(
  plan: PlanScheduleLike, charges: LinkedCharge[], now: number,
): PlanState {
  const base = { due_at: null, late_days: null, missed_cycles: 0, paid_at: null, paid_amount: null };
  const active = plan.is_active == null ? true : !!plan.is_active;
  if (!active || (plan.end_date != null && plan.end_date <= now)) return { kind: "ended", ...base };
  if (!charges.length) return { kind: "no_history", ...base };

  const count = plan.period_count ?? 1;
  const early = earlyToleranceSec(periodSeconds(plan.period, count));
  const due = lastDueUnix(plan.start_date, plan.period, count, now);
  if (due == null) return { kind: "due", ...base };

  const lateDays = Math.floor((now - due) / DAY);
  // The latest charge that settles this cycle (a second charge in one cycle is rare — a correction,
  // a refund-and-recharge — and the latest one is the price that stands).
  const settle = charges
    .filter((c) => c.time >= due - early)
    .sort((a, b) => b.time - a.time)[0];
  if (settle) {
    const declared = plan.period_amount;
    const sameCurrency = (settle.currency_code ?? 980) === (plan.currency_code ?? 980);
    const differs = !!declared && declared > 0 && sameCurrency
      && Math.abs(settle.amount - declared) > declared * PRICE_TOLERANCE;
    return {
      kind: differs ? "changed" : "paid",
      due_at: due, late_days: 0, missed_cycles: 0,
      paid_at: settle.time, paid_amount: settle.amount,
    };
  }

  const firstCharge = Math.min(...charges.map((c) => c.time));
  // The current cycle counts as missed only once the grace has passed.
  let missed = lateDays >= LATE_GRACE_DAYS ? 1 : 0;
  let latestMissedDue: number | null = missed ? due : null;
  let cursor = due;
  for (let i = 0; i < MAX_MISSED_WALK; i++) {
    const prev = lastDueUnix(plan.start_date, plan.period, count, cursor - 1);
    if (prev == null || prev < firstCharge - early) break;
    const hit = charges.some((c) => c.time >= prev - early && c.time < cursor - early);
    if (hit) break;
    missed++;
    latestMissedDue ??= prev;
    cursor = prev;
  }

  if (missed === 0) {
    return { kind: "due", due_at: due, late_days: Math.max(0, lateDays), missed_cycles: 0, paid_at: null, paid_amount: null };
  }
  const at = latestMissedDue ?? due;
  return {
    kind: missed >= 3 ? "stopped" : missed === 2 ? "missing" : "late",
    due_at: at, late_days: Math.floor((now - at) / DAY), missed_cycles: missed,
    paid_at: null, paid_amount: null,
  };
}

/**
 * §PLAN-REPRICE — does a charge at `t` sit where this plan's NEXT charge was expected?
 *
 * The amount gate (`amountMatches`, ±10%) is what makes alias matching safe: without it a loose
 * name could pull an unrelated purchase from the same merchant into a plan. A price change breaks
 * that gate by definition, so for a repriced charge the gate is REPLACED, not widened — and the
 * replacement is time: the charge must land one, two or three declared cycles after the plan's
 * last linked charge, within a fifth of a cycle (at least three days, for a posting delay).
 * A one-off purchase from the same brand in the middle of a cycle does not fit, and that is the
 * case the amount gate was guarding against.
 *
 * Anchored on the last LINKED charge, not on `start_date`: plans are created by hand, often with
 * an approximate date, while the linked charges are the biller's actual rhythm.
 */
export function fitsNextCycle(
  lastLinked: number, t: number, period: string, count: number,
): boolean {
  const cycle = declaredIntervalDays(period, count) * DAY;
  const tol = Math.max(3 * DAY, cycle * 0.2);
  const gap = t - lastLinked;
  if (gap <= 0) return false;
  for (let k = 1; k <= 3; k++) {
    if (Math.abs(gap - k * cycle) <= tol) return true;
  }
  return false;
}

/**
 * The widest price move §PLAN-REPRICE accepts, as a ratio to the last linked charge.
 *
 * Real subscription increases are tens of percent (YouTube 100 → 179 is ×1.79); ×3 is past every
 * one on record and still refuses a 10 000 ₴ purchase posing as a repriced 100 ₴ plan. Downward
 * the same factor. A trial → paid step (0 or 1 ₴, then the full price) is deliberately OUTSIDE this:
 * it is a different story with its own detector, not a price change.
 */
export const REPRICE_MAX_FACTOR = 3;

export function repriceAmountPlausible(amount: number, lastAmount: number): boolean {
  if (amount <= 0 || lastAmount <= 0) return false;
  const r = amount / lastAmount;
  return r <= REPRICE_MAX_FACTOR && r >= 1 / REPRICE_MAX_FACTOR;
}
