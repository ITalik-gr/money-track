/**
 * The business, read as its own organism (docs/TAX.md §0.1).
 *
 * Everything else in this project answers a question about the PERSON: how much is mine, what do
 * I live on, will it last. This file answers questions about the BUSINESS, and they do not reduce
 * to the personal ones:
 *
 *   · what did it earn this quarter, and is that more than the same quarter last year;
 *   · WHO pays, and with what rhythm — the spending side has had `merchants.ts` from the start,
 *     the income side had nothing at all;
 *   · what does the business itself cost, and what is left AFTER tax;
 *   · what is the EFFECTIVE rate — at a low income the fixed contribution dominates the
 *     percentage one, and that is only visible as a share.
 *
 * ⚠️ §TAX-UAH: hryvnia throughout, like the rest of the tax domain. The state levies in hryvnia,
 * and a business figure that moved with the display base could not be compared to the tax figure
 * printed beside it.
 */
import type { AppDb } from "../platform/db-shim.ts";
import * as taxRepo from "../../repo/tax.ts";
import { localParts, localQuarterStart, localYearStart, localYmd } from "./time.ts";
import { quarterLabel, accrualsFor, readProfile } from "./tax.ts";
import { ratesFor } from "./tax-rates.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";

const DAY = 86_400;

export interface Rhythm {
  /** Receipts in the window. */
  n: number;
  /** Median days between consecutive receipts; null under two receipts. */
  median_gap_days: number | null;
  /** Days since the last one — the number that says «it has gone quiet». */
  days_since_last: number | null;
  /** Average receipt, ₴ minor. */
  avg_uah: number;
}

/**
 * The MEDIAN gap, not the mean.
 *
 * One three-month gap in an otherwise monthly year drags a mean past six weeks and the reading
 * becomes «you get paid every month and a half», which is true of no month that actually happened.
 * The same reason §RHYTHM matches subscriptions on rhythm rather than on an average.
 */
export function rhythmOf(times: number[], now: number, totalUah: number): Rhythm {
  const n = times.length;
  if (n === 0) return { n: 0, median_gap_days: null, days_since_last: null, avg_uah: 0 };
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push((times[i]! - times[i - 1]!) / DAY);
  gaps.sort((a, b) => a - b);
  const median = gaps.length
    ? gaps.length % 2
      ? gaps[(gaps.length - 1) / 2]!
      : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2
    : null;
  return {
    n,
    median_gap_days: median == null ? null : Math.round(median),
    days_since_last: Math.floor((now - times[n - 1]!) / DAY),
    avg_uah: Math.round(totalUah / n),
  };
}

export interface QuarterRow {
  label: string;
  income: number;
  /** Accrued for that quarter — from the rates in force THEN (§TAX-RATES). */
  tax: number;
  expenses: number;
  /** income − expenses − tax: what the business actually handed the person. */
  net: number;
  /** tax ÷ income, in tenths of a percent; null when nothing came in. */
  effective_pct: number | null;
  /**
   * The part of the tax that does NOT move with income — ЄСВ, and the fixed ЄП/ВЗ of groups 1–2.
   *
   * Reported separately because it is the number that explains a surprised person. At 20 000 ₴ a
   * quarter the percentage taxes are 1 200 ₴ and ЄСВ is 5 707 ₴: the effective rate is 34%, not
   * the 5% on every rates table. Somebody who planned around «5%» is short by the difference, and
   * no single blended figure would have told them.
   */
  fixed: number;
}

export interface BusinessOverview {
  quarters: QuarterRow[];
  /** §BUDGET-PACE — where this quarter is heading, and what each group would charge for it. */
  outlook: QuarterOutlook;
  counterparties: taxRepo.Counterparty[];
  /** Where the business's own costs went this quarter, by category root. */
  costs: taxRepo.BusinessExpenseRow[];
  /** §TAX-DUE meets §RHYTHM: the tax falls due before the money that pays it arrives. */
  cash_gap: CashGap | null;
  rhythm: Rhythm;
  /** Same quarter one year earlier, for the only comparison a seasonal business can use. */
  year_ago: { label: string; income: number } | null;
  /** How much of the quarter's income the single largest client is — concentration risk. */
  top_share_pct: number | null;
}

/**
 * The whole business picture for the last `quarters` quarters.
 *
 * One call rather than five: every figure here is over the SAME population and the same windows,
 * and splitting them would let two cards on one screen disagree about a quarter — the failure
 * `Stats.tsx` keeps its shared request to avoid.
 */
export async function businessOverview(
  db: AppDb, now: number, quarters = 6, locale: NotifLocale = "uk",
): Promise<BusinessOverview> {
  const profile = await readProfile(db);
  const rows: QuarterRow[] = [];

  for (let i = quarters - 1; i >= 0; i--) {
    const qStart = localQuarterStart(now, -i);
    const qEnd = localQuarterStart(now, -i + 1);
    const income = await taxRepo.businessIncome(db, qStart, qEnd);
    const spend = await taxRepo.businessExpenses(db, qStart, qEnd);
    // The accrual is recomputed rather than read from `tax_obligations`, on purpose: the stored
    // rows only go back as far as the module has been switched on, and a history chart that is
    // empty before that date would read as «the business earned nothing then».
    const accruals = profile.enabled ? await accrualsFor(db, profile, qStart) : [];
    const accrued = accruals.reduce((n, a) => n + a.amount, 0);
    // «Fixed» is a property of the GROUP, not of the kind: for group 3 the single tax is a
    // percentage, for groups 1–2 the very same kind is a flat monthly sum.
    const fixed = accruals
      .filter((a) => a.kind === "social_contribution" || profile.group !== 3)
      .reduce((n, a) => n + a.amount, 0);
    rows.push({
      label: quarterLabel(qStart),
      income: income.base_uah,
      tax: accrued,
      expenses: spend.uah,
      net: income.base_uah - spend.uah - accrued,
      effective_pct: income.base_uah > 0 ? Math.round((accrued / income.base_uah) * 1000) / 10 : null,
      fixed,
    });
  }

  const qStart = localQuarterStart(now);
  // ⚠️ The QUARTER's own window, not `[qStart, now)`. `top_share_pct` below divides one of these
  // totals by the quarter row's income, and the two were read over different windows — so a
  // receipt dated ahead of today (a manual entry takes any `time`) landed in the denominator and
  // not in the numerator, and the concentration figure came out understated against a total
  // printed two lines above it. One quarter, one window (A2 audit, 2026-09-18).
  const parties = await taxRepo.counterparties(db, qStart, localQuarterStart(now, 1));
  const times = await taxRepo.receiptTimes(db, localYearStart(now), now);
  const ytd = await taxRepo.businessIncome(db, localYearStart(now), now);

  // A year earlier, same quarter: the only honest comparison for work that has a season. A
  // quarter-on-quarter delta would call every January a collapse.
  const yearAgoStart = localQuarterStart(now, -4);
  const yearAgo = await taxRepo.businessIncome(db, yearAgoStart, localQuarterStart(now, -3));

  const thisQuarter = rows.at(-1)?.income ?? 0;
  const top = parties[0]?.total_uah ?? 0;

  return {
    quarters: rows,
    outlook: await quarterOutlook(db, now),
    // The nearest UNPAID obligation, read from the same rows `taxStatus` reads — not recomputed
    // here, or the two screens could name different deadlines for one quarter.
    cash_gap: await cashGap(db, now, await nextUnpaid(db, now)),
    counterparties: parties,
    costs: await taxRepo.businessExpensesByCategory(db, qStart, localQuarterStart(now, 1), locale),
    rhythm: rhythmOf(times, now, ytd.base_uah),
    // Absent rather than zero when there is no such quarter: «−100% year on year» for a business
    // that did not exist yet is a lie with a number attached.
    year_ago: yearAgo.n > 0 ? { label: quarterLabel(yearAgoStart), income: yearAgo.base_uah } : null,
    top_share_pct: thisQuarter > 0 ? Math.round((top / thisQuarter) * 1000) / 10 : null,
  };
}

/** What one group would owe on a given quarter's income — the input to «should I switch». */
export interface GroupCost {
  group: 1 | 2 | 3;
  /** ЄП + ВЗ for the quarter, ₴ minor. */
  tax: number;
  /** ЄСВ for the quarter, reported apart because it does not move with income. */
  esv: number;
  total: number;
  /** The group's own annual ceiling — a cheaper group with a lower ceiling is not cheaper. */
  annual_limit: number;
  /** True when this year's income already exceeds that ceiling: the group is not available. */
  over_limit: boolean;
}

export interface QuarterOutlook {
  label: string;
  /** Income booked so far this quarter, ₴ minor. */
  income_so_far: number;
  /** The whole quarter at the current pace — null until the pace means something. */
  projected_income: number | null;
  /** Accrued so far, and what the projection would accrue by the quarter's end. */
  accrued_now: number;
  projected_tax: number | null;
  days_elapsed: number;
  days_left: number;
  /** Every group priced on the SAME income, so the comparison is a comparison. */
  groups: GroupCost[];
}

/**
 * The nearest unpaid obligation — the same list, the same order and the same window `taxStatus`
 * uses, so the deadline named here is the deadline named there.
 */
async function nextUnpaid(
  db: AppDb, now: number,
): Promise<{ due_date: string; amount: number } | null> {
  const rows = await taxRepo.listObligations(db, `${localParts(localYearStart(now)).y - 1}-01`);
  const unpaid = rows.filter((o) => !o.paid_tx_id && o.amount > 0)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const head = unpaid[0];
  return head ? { due_date: head.due_date, amount: head.amount } : null;
}

export interface CashGap {
  /** The deadline, 'YYYY-MM-DD' Kyiv. */
  due_date: string;
  amount: number;
  /** When the next receipt is expected, from THIS business's rhythm. */
  expected_income: string;
  days_short: number;
}

/**
 * The gap only this app can see: the tax is due BEFORE the money that pays it arrives.
 *
 * A freelancer paid on the 25th and taxed on the 19th is short every single quarter, and neither
 * figure looks like a problem on its own — which is exactly why nothing tells them. The statement
 * is made only when both halves are real: an unpaid obligation with a date, and a rhythm solid
 * enough to name a day (§RHYTHM — three receipts and a median gap, not an average).
 *
 * ⚠️ It names a DATE and a shortfall in days, and stops there. Whether to invoice early, hold the
 * reserve back or pay from personal money is the owner's call, and an app that recommended one
 * would be advising on a cash position it can only partly see (there may be a bank it does not
 * sync). §TAX-RESERVE already says what is promised; this says when it is needed.
 */
export async function cashGap(
  db: AppDb, now: number, next: { due_date: string; amount: number } | null,
): Promise<CashGap | null> {
  if (!next) return null;
  const times = await taxRepo.receiptTimes(db, localYearStart(now, -1), now);
  const r = rhythmOf(times, now, 0);
  if (r.n < 3 || r.median_gap_days == null || r.median_gap_days < 7) return null;

  const last = times[times.length - 1]!;
  const expectedAt = last + r.median_gap_days * DAY;
  const expected = localYmd(expectedAt);
  /**
   * ⚠️ TWO DATES, subtracted as dates — never an instant minus a date.
   *
   * `due_date` is a Kyiv calendar date with no time of day; `expectedAt` is a real instant. Taking
   * the difference directly would mix the two and leave a two-or-three-hour skew inside a figure
   * measured in DAYS, which lands wrong exactly at the boundary this block exists to report. So
   * the instant becomes its Kyiv date first, and both sides are then parsed as UTC midnights —
   * the same arithmetic `taxStatus` uses for `days_left`, for the same reason (§APP_TZ).
   */
  const daysShort = Math.round(
    (Date.parse(`${expected}T00:00:00Z`) - Date.parse(`${next.due_date}T00:00:00Z`)) / 86_400_000,
  );
  if (daysShort <= 0) return null;
  return { due_date: next.due_date, amount: next.amount, expected_income: expected, days_short: daysShort };
}

export interface QuietClient {
  name: string;
  /** How many payments the rhythm was read from. */
  n: number;
  median_gap_days: number;
  days_since_last: number;
  /** ₴ minor: what this client usually pays — the size of what has gone quiet. */
  avg_uah: number;
}

/**
 * A client who used to pay on a rhythm and has stopped — the income-side twin of §SUB-DETECT.
 *
 * The spending side has watched for a subscription that went quiet since the beginning; the income
 * side had nothing, and it is the more consequential of the two: a dead subscription is money
 * saved, a client who stopped paying is the business shrinking, and a freelancer normally notices
 * it weeks late because no single missing invoice looks like an event.
 *
 * ⚠️ RHYTHM, not a fixed threshold — the same rule §RHYTHM keeps. A client who pays monthly is
 * late at six weeks; a client who pays twice a year is not late at four months, and a «90 days
 * since last payment» rule would announce the second one every year while missing the first for a
 * month. So the comparison is against THIS client's own median gap.
 *
 * ⚠️ Three payments minimum, and a gap of at least a week. Two payments give one interval, which
 * is not a rhythm but a coincidence — and a client who pays every other day is «late» by lunchtime
 * on the third, which is how a signal becomes noise.
 */
export async function quietClients(db: AppDb, now: number, lookbackDays = 550): Promise<QuietClient[]> {
  const rows = await taxRepo.counterparties(db, now - lookbackDays * DAY, now, 100);
  const out: QuietClient[] = [];
  for (const c of rows) {
    if (c.n < 3 || c.name === "?") continue;
    const times = await taxRepo.receiptTimes(db, now - lookbackDays * DAY, now, c.name);
    const r = rhythmOf(times, now, c.total_uah);
    if (r.median_gap_days == null || r.median_gap_days < 7 || r.days_since_last == null) continue;
    // Twice the usual gap, and never sooner than a week past it: doubling alone would fire at 16
    // days for a client who pays weekly, which is inside the ordinary slack of an invoice.
    const late = r.days_since_last > Math.max(r.median_gap_days * 2, r.median_gap_days + 7);
    if (late) {
      out.push({
        name: c.name, n: r.n, median_gap_days: r.median_gap_days,
        days_since_last: r.days_since_last, avg_uah: r.avg_uah,
      });
    }
  }
  // The biggest payer first: «who has gone quiet» is a question about the business, and the
  // answer is ordered by how much of it is missing.
  return out.sort((a, b) => b.avg_uah - a.avg_uah);
}

/**
 * §BUDGET-PACE for the tax quarter: what this quarter will cost, and what another group would.
 *
 * TWO questions in one block because they share an income figure, and computing that figure twice
 * is how two cards on one screen come to disagree about the same quarter.
 *
 * ⚠️ A MINIMUM WINDOW before anything is projected. Income arrives in lumps — one invoice on the
 * 2nd of the month is not «this quarter's pace», and a projection from it would read as a
 * confident forecast built from a single day. Under `MIN_PACE_DAYS` the projection is null and the
 * screen says «too early», which is the §CADENCE answer: a delta is worth reporting only when the
 * window under it can carry one.
 *
 * ⚠️ Every group is priced on the SAME income and against its OWN ceiling. «Group 1 would cost
 * 332 ₴ a month» is true and useless on its own: group 1's annual limit is 1 444 049 ₴, so for a
 * business past that figure the cheap answer is not an option at all — which is why `over_limit`
 * travels with the price rather than being left for the reader to check.
 */
const MIN_PACE_DAYS = 14;

export async function quarterOutlook(db: AppDb, now: number): Promise<QuarterOutlook> {
  const profile = await readProfile(db);
  const qStart = localQuarterStart(now);
  const qEnd = localQuarterStart(now, 1);
  const income = await taxRepo.businessIncome(db, qStart, qEnd);
  const ytd = await taxRepo.businessIncome(db, localYearStart(now), localYearStart(now, 1));

  const daysElapsed = Math.max(1, Math.floor((now - qStart) / DAY));
  const daysTotal = Math.round((qEnd - qStart) / DAY);
  const daysLeft = Math.max(0, daysTotal - daysElapsed);
  const projectedIncome = daysElapsed >= MIN_PACE_DAYS
    ? Math.round((income.base_uah / daysElapsed) * daysTotal)
    : null;

  const accrued = (await accrualsFor(db, profile, qStart)).reduce((n, a) => n + a.amount, 0);

  const priceOn = (group: 1 | 2 | 3, base: number): GroupCost => {
    // The rates in force at the quarter's START, like every other accrual (§TAX-RATES).
    const r = ratesFor({ ...profile, group }, localYmd(qStart));
    const tax = group === 3
      ? Math.round((base * r.single_income_pct) / 100) + Math.round((base * r.levy_income_pct) / 100)
      : (r.single_monthly + r.levy_monthly) * 3;
    return {
      group, tax, esv: r.esv_monthly * 3, total: tax + r.esv_monthly * 3,
      annual_limit: r.annual_limit,
      over_limit: ytd.base_uah > r.annual_limit,
    };
  };
  const basis = projectedIncome ?? income.base_uah;

  return {
    label: quarterLabel(qStart),
    income_so_far: income.base_uah,
    projected_income: projectedIncome,
    accrued_now: accrued,
    projected_tax: projectedIncome == null ? null : priceOn(profile.group, projectedIncome).total,
    days_elapsed: daysElapsed,
    days_left: daysLeft,
    groups: [1, 2, 3].map((g) => priceOn(g as 1 | 2 | 3, basis)),
  };
}
