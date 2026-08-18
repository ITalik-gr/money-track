/**
 * §INCOME-PLAN — the dated series of money MOVING, in both directions.
 *
 * Extracted from `routes/api/analytics.ts` (2026-08-14) when adding income pushed that file past
 * its C3 ceiling. The seam is right on its own terms and not merely convenient: the route's job is
 * to read a window out of a query string, and everything below is a domain question — which plans
 * fall on which day, converted into which currency, in which direction. That is `lib/finance`
 * work, the same argument that moved `networth.ts` out of the same file.
 *
 * ⚠️ **An inflow is a NEGATIVE `amount`, not a separate array.** Every reader wants the same thing
 * — a running balance — and a second array would make each of them re-derive it. That is how the
 * calendar and the liquidity drafter would eventually disagree about which day goes red, which is
 * §CUR-PLAN in a different costume. With one signed series, a day's net is `sum`, and the balance
 * is one subtraction.
 */
import type { AppDb } from "../platform/db-shim.ts";
import * as planningRepo from "../../repo/planning.ts";
import { chargesBetween } from "./subscriptions.ts";
import { localYmd, localMonthStart } from "./stats.ts";
import type { Rates } from "./money.ts";
import type { Env } from "../../env.ts";
import { incomeOutlook } from "./income.ts";

export interface CashflowMove {
  at: number;
  date: string;
  title: string;
  /** ₴ minor. POSITIVE = money leaves, NEGATIVE = money arrives. */
  amount: number;
  amount_orig: number;
  currency_code: number;
  category_id: number | null;
  kind: string;
}

export async function cashflowMoves(
  db: AppDb, rates: Rates, from: number, to: number,
): Promise<CashflowMove[]> {
  const [planned, incomePlans] = await Promise.all([
    planningRepo.activeWithCategory(db),
    planningRepo.activeIncomePlans(db),
  ]);

  // §CUR-PLAN: `amount` in ₴, because it is summed per day and subtracted from the cushion (also
  // ₴). The original stays in `amount_orig`/`currency_code` so the UI can show "$5" beside it.
  // §SUB-MONTH: the expansion into dates is the canonical `chargesBetween`, never a private loop.
  const outflow = chargesBetween(planned, rates, from, to).map((ch): CashflowMove => ({
    at: ch.at, date: localYmd(ch.at), title: ch.plan.title, amount: ch.amount,
    amount_orig: ch.plan.period_amount ?? 0, currency_code: ch.plan.currency_code ?? 980,
    category_id: ch.plan.category_id, kind: ch.plan.kind,
  }));
  const inflow = chargesBetween(incomePlans, rates, from, to).map((ch): CashflowMove => ({
    at: ch.at, date: localYmd(ch.at), title: ch.plan.title, amount: -ch.amount,
    amount_orig: -(ch.plan.period_amount ?? 0), currency_code: ch.plan.currency_code ?? 980,
    category_id: ch.plan.category_id, kind: "income",
  }));

  return [...outflow, ...inflow].sort((a, b) => a.at - b.at);
}

/**
 * §4 Safe-to-spend — what is free between now and the 1st.
 *
 * Moved out of the route with `cashflowMoves` (C3), and it belongs here for the same reason: it
 * composes three canonical sources (month-to-date totals, the subscription SCHEDULE, the income
 * outlook) and the route only supplies "now".
 *
 * ⚠️ **`safe` is built on money that ACTUALLY ARRIVED, deliberately.** The income/expense
 * asymmetry §INCOME-PLAN fixes belongs in the FORECAST, where a projection is what is being asked
 * for. Here it must not be fixed: this is the number people spend against, and propping it up with
 * an invoice that has not been paid — income being neither the same size nor on time — would be
 * the app inventing money. Expected travels beside it as its own quantity, so the screen says
 * "вільно X, очікується ще Y" — the sentence that stays true when Y never arrives.
 *
 * ⚠️ §SUB-MONTH: "subscriptions left" is the SCHEDULE to month end, not "monthly total minus what
 * is already paid". The old formula summed every active plan's `period_amount` as if monthly, so a
 * quarterly charge weighed full every month and a weekly one counted once.
 */
export interface SafeToSpendCalc {
  safe: number; income: number; spend: number; essential: number; discretionary: number;
  subs_monthly: number; subs_remaining: number; month_start: number;
  income_expected: number; income_overdue: number; income_estimated: boolean;
}

export async function safeToSpend(
  env: Env, rates: Rates, mult: string, now: number,
): Promise<SafeToSpendCalc> {
  const monthStart = localMonthStart(now);
  const monthEnd = localMonthStart(now, 1);

  const analyticsRepo = await import("../../repo/analytics.ts");
  const [tot, plans, outlook] = await Promise.all([
    analyticsRepo.monthToDate(env.DB, { mult }, { from: monthStart, to: now }),
    planningRepo.activeForSchedule(env.DB),
    incomeOutlook(env, now),
  ]);

  const sum = (from: number, to: number) =>
    chargesBetween(plans, rates, from, to).reduce((s, ch) => s + ch.amount, 0);

  const income = tot?.income ?? 0;
  const spend = tot?.spend ?? 0;
  const essential = tot?.essential ?? 0;
  const subsRemaining = sum(now + 1, monthEnd - 1);
  return {
    safe: income - spend - subsRemaining,
    income, spend, essential,
    discretionary: Math.max(0, spend - essential),
    subs_monthly: sum(monthStart, monthEnd - 1),
    subs_remaining: subsRemaining,
    month_start: monthStart,
    income_expected: outlook.expected_remaining,
    income_overdue: outlook.overdue,
    income_estimated: outlook.estimated,
  };
}
