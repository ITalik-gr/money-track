/**
 * §TIME-CTX (2026-08-27) — the ONLY calendar a model is given, and the anchors its answer is
 * checked against. One module, because those two are one fact seen twice: whatever we hand over is
 * exactly what may be said back, and a second reading of "which dates did we supply" is the shape
 * that drifts (§CUR-PLAN).
 *
 * It exists because the feed shipped «Rent due in 11 days, cushion covers only 0.8 months total»
 * on 2026-08-26 — for a rent the user pays on the 20th. The rent is not a `planned_payment`, so it
 * was in no `upcoming_charges` row and had no date anywhere in the payload; the model read the
 * user's own prose in `situation` («12500 кожного 20 числа») as a schedule and invented a distance
 * to it. The snapshot did not even carry TODAY, so there was nothing to invent it from either.
 *
 * ⚠️ Every figure in that sentence was under 100, i.e. below the floor of `numbersAreGrounded` —
 * which is why the calendar needs a guard of its own (`timeClaimsAreGrounded`) rather than a
 * lower floor on the money one.
 */
import { localYmd, localParts, localMonthStart } from "../finance/stats.ts";
import { nextChargeUnix, plannedUAH } from "../finance/subscriptions.ts";
import type { Rates } from "../finance/money.ts";

export interface UpcomingCharge { in_days: number; date: string }

export interface TimeContext {
  /** Spread into the AI payload. */
  fields: Record<string, unknown>;
  /** Day numbers and 0-based months the payload STATES — nothing else may be claimed. */
  anchors: { days: number[]; months: number[] };
}

export function buildTimeContext(
  now: number, upcoming: UpcomingCharge[], runwayMonths: number | null, trendMonths: string[],
): TimeContext {
  const daysLeft = Math.max(0, Math.round((localMonthStart(now, 1) - now) / 86400));
  // Days as well as months: «cushion lasts 24 days» is a sentence people actually read, and
  // without the figure the model derived it from `runway_months` by eye — a computation the prompt
  // forbids and the guard could not see.
  const runwayDays = runwayMonths == null ? null : Math.round(runwayMonths * 30.44);

  return {
    fields: {
      today: localYmd(now),
      day_of_month: localParts(now).d,
      days_left_in_month: daysLeft,
      runway_days: runwayDays,
      time_note:
        "today, day_of_month, days_left_in_month, runway_days and upcoming_charges (in_days / date / " +
        "on_day) are the ONLY calendar you have. Never state a due date, a deadline or an \"in N days\" for " +
        "anything that is not an upcoming_charges row: a payment that repeats every month in the history but " +
        "is not there has NO known date. ⚠️ situation is the user's own prose — \"I pay rent on the 20th\" is " +
        "background, NOT a schedule you may turn into a countdown.",
    },
    anchors: {
      days: [
        ...upcoming.map((u) => u.in_days),
        ...upcoming.map((u) => Number(u.date.slice(8, 10))),
        localParts(now).d, daysLeft,
        ...(runwayDays == null ? [] : [runwayDays]),
        // The window lengths the payload names itself (period_days, the 30-day charge horizon,
        // a week): a sentence like «за 90 днів» is quoting the payload, not inventing a date.
        90, 30, 7, 1,
      ],
      months: [
        localParts(now).m - 1,
        ...upcoming.map((u) => Number(u.date.slice(5, 7)) - 1),
        ...trendMonths.map((m) => Number(m.slice(5, 7)) - 1),
      ],
    },
  };
}

/** A row of `planned_payments` as the snapshot selects it. */
export interface PlannedRow {
  title: string; period: string; period_count: number; start_date: number;
  period_amount: number | null; currency_code: number | null; kind: string;
}

/**
 * The nearest 30 days of scheduled charges — the app's whole answer to "when".
 *
 * ⚠️ §CUR-PLAN: the field is named `amount_uah`, so it must BE in the base unit — this once
 * divided `period_amount` by 100 with no conversion, and a $5 subscription reached the model as 5.
 * ⚠️ The DATE travels with the distance. Handing over "in 6 days" and no notion of what day it is
 * leaves the model to supply a calendar of its own, which is exactly what it did.
 */
export function buildUpcomingCharges(
  rows: PlannedRow[], rates: Rates, now: number,
): { title: string; in_days: number; date: string; on_day: number; amount_uah: number; kind: string }[] {
  const in30 = now + 30 * 86400;
  return rows
    .map((p) => ({
      title: p.title,
      at: nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now),
      amount_uah: Math.round(plannedUAH(p.period_amount, p.currency_code, rates) / 100),
      kind: p.kind,
    }))
    .filter((p) => p.at <= in30)
    .sort((a, b) => a.at - b.at)
    .slice(0, 12)
    .map((p) => {
      const date = localYmd(p.at);
      return {
        title: p.title, in_days: Math.max(0, Math.round((p.at - now) / 86400)),
        date, on_day: Number(date.slice(8, 10)), amount_uah: p.amount_uah, kind: p.kind,
      };
    });
}
