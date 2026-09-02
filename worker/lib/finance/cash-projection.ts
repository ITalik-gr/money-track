/**
 * §CASH-PROJ — the projected half of the cumulative-flow chart.
 *
 * WHAT WAS WRONG. The dashed line was computed IN THE CLIENT (`toCumulative`) as one number: the
 * MEDIAN daily net, repeated for every day left in the period. So it was always a straight line at
 * a constant slope — reported by the owner as «просто бесполезний… завжди лінія рівно плавно вниз
 * йде». It could not know that rent leaves on the 20th, that four subscriptions land in the first
 * week, or that the salary arrives at all: a median of daily nets deliberately discards exactly
 * those, because a lump would otherwise be smeared across every day.
 *
 * That was the right defence against the wrong problem. A lump is not noise — it is the most
 * predictable thing in the month. What the median could not do is put it on ITS DAY, because the
 * client had no schedule and no calendar shape to put it on.
 *
 * WHAT THIS DOES, and every input is already canon:
 *
 *   1. **Scheduled money, by DATE** — `cashflowMoves` (§SUB-MONTH `chargesBetween`, §INCOME-PLAN).
 *      Subscriptions, instalments, rent-as-a-plan and expected income, each on the day it falls.
 *   2. **Ordinary spending, SHAPED** — the day-of-month and weekday profiles that already draw the
 *      Trends tab (§WEEKDAY), applied as WEIGHTS to the remaining days.
 *   3. **Recurring income, by rhythm** — income that lands on the same day of the month in most
 *      months, at its MEDIAN amount (§SUB-DETECT's rule, one axis over).
 *
 * ⚠️ **NO AI, deliberately** — the owner asked whether a daily model pass would help. Every figure
 * above is already computed by this codebase for other screens. An AI pass would be a SECOND
 * opinion about numbers the app already has, drifting from the first wherever nobody looks — which
 * is the failure §CUR-PLAN, §REFUND and §A1-WRITE were each written after. It would also cost money
 * daily to answer a question arithmetic answers exactly.
 *
 * ⚠️ **The TOTAL is preserved; only the SHAPE moves.** Weights are normalised so the remaining
 * ordinary spend sums to `ordinaryDaily × remainingDays` — the same quantity the flat line used.
 * A projection that changes both the shape and the total cannot be checked against anything, and
 * the total is the half the rest of the app (burn, runway, safe-to-spend) already agrees on.
 *
 * ⚠️ **Ordinary spending EXCLUDES anything linked to a plan** (`planned_id IS NULL` in the repo).
 * Scheduled charges are added back by date, so counting them in the profile too would bill every
 * subscription twice — and it would look plausible, because both halves are real spending.
 *
 * ⚠️ **Projected income is NEVER canonical income** (§INCOME-PLAN). It exists on this chart and
 * nowhere else: `safe`, `income` and the advisor's snapshot keep counting money that arrived. A
 * chart is where a projection is what was asked for; a spendable balance is not.
 */
import { localParts, localDayStart } from "./time.ts";
import type { AppDb } from "../platform/db-shim.ts";
import type { Rates } from "./money.ts";
import type { CashProjection } from "../../../shared/api/analytics.ts";

/** One projected day. Amounts are minor units of the reader's base, `spend` positive as it leaves. */
export interface ProjectedDay {
  at: number;
  date: string;
  /** Plan charges falling on this day. */
  scheduled: number;
  /** Everything else the shape expects to be spent. */
  ordinary: number;
  /** Expected inflow: dated income plans plus recurring paydays. */
  income: number;
}

export interface ProjectionInput {
  /** Exclusive lower bound: the last day with ACTUAL data. Projection starts the day after. */
  after: number;
  /** Inclusive upper bound: the end of the period being drawn. */
  until: number;
  /** Dated plan moves, `cashflowMoves` convention: positive leaves, negative arrives. */
  scheduled: { at: number; amount: number }[];
  /** Expected ordinary (unplanned) spend for one average day, minor units. */
  ordinaryDaily: number;
  /** `typical` unplanned spend per day-of-month, index 0 = the 1st. Zeroes are allowed. */
  domProfile: number[];
  /** `typical` unplanned spend per weekday, index 0 = Sunday. */
  dowProfile: number[];
  /** Days of the month that reliably receive income, with the median amount. */
  paydays: { dom: number; amount: number }[];
}

/**
 * How far a single day's weight may stray from an average day.
 *
 * Without a clamp one enormous historical day (a deposit, a car repair, a tax quarter that slipped
 * past the unplanned filter) turns into a spike the reader is told to expect — a forecast that
 * predicts a specific disaster on a specific date is worse than a flat line, because it will be
 * believed. 2.5× keeps a real payday visible while refusing to promise a catastrophe.
 */
const MAX_WEIGHT = 2.5;
const MIN_WEIGHT = 0.25;

/** Mean of the non-zero entries — a profile bucket with no history is absence, not a zero day. */
function meanOfActive(profile: number[]): number {
  const active = profile.filter((v) => v > 0);
  return active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
}

export function projectDays(input: ProjectionInput): ProjectedDay[] {
  const { after, until, scheduled, ordinaryDaily, domProfile, dowProfile, paydays } = input;
  const days: { at: number; dom: number; dow: number }[] = [];
  // Step through LOCAL midnights rather than adding 86400: a DST change makes one day 23 hours
  // long, and a fixed step drifts onto the wrong calendar day within a season (§APP_TZ).
  // ⚠️ Snap to `after`'s OWN day first, then step. `localDayStart(after + 36h)` looks equivalent
  // and is not: when `after` falls before noon local, +36h lands in the day after next and the
  // first projected day is silently skipped — a forecast one day short, which nothing on the chart
  // would show. Caught by the flat-line test, which is the only one that counts the days.
  for (let d = localDayStart(localDayStart(after) + 36 * 3600); d <= until; d = localDayStart(d + 36 * 3600)) {
    const p = localParts(d);
    days.push({ at: d, dom: p.d, dow: new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() });
  }
  if (!days.length) return [];

  const domMean = meanOfActive(domProfile);
  const dowMean = meanOfActive(dowProfile);
  const weightOf = (dom: number, dow: number) => {
    // A profile with no signal contributes 1: the day keeps the average, rather than vanishing.
    const dw = domMean > 0 && domProfile[dom - 1]! > 0 ? domProfile[dom - 1]! / domMean : 1;
    const ww = dowMean > 0 && dowProfile[dow]! > 0 ? dowProfile[dow]! / dowMean : 1;
    return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, dw * ww));
  };

  const weights = days.map((d) => weightOf(d.dom, d.dow));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  // Normalise so the remaining ordinary spend equals `ordinaryDaily × days` — the shape changes,
  // the total does not.
  const scale = weightSum > 0 ? (ordinaryDaily * days.length) / weightSum : 0;

  const byDay = new Map<number, { out: number; in: number }>();
  for (const m of scheduled) {
    const key = localDayStart(m.at);
    const slot = byDay.get(key) ?? { out: 0, in: 0 };
    if (m.amount >= 0) slot.out += m.amount; else slot.in += -m.amount;
    byDay.set(key, slot);
  }
  const paydayBy = new Map(paydays.map((p) => [p.dom, p.amount]));

  return days.map((d, i) => {
    const sched = byDay.get(d.at) ?? { out: 0, in: 0 };
    return {
      at: d.at,
      date: `${localParts(d.at).y}-${String(localParts(d.at).m).padStart(2, "0")}-${String(d.dom).padStart(2, "0")}`,
      scheduled: Math.round(sched.out),
      ordinary: Math.round(weights[i]! * scale),
      // A dated income plan WINS over the detected payday for the same day: the plan is a stated
      // fact, the rhythm is an inference from it or from something like it, and adding both would
      // count one salary twice on the one day it is most likely to be right about.
      income: Math.round(sched.in > 0 ? sched.in : (paydayBy.get(d.dom) ?? 0)),
    };
  });
}

/**
 * Which days of the month reliably receive income, and how much.
 *
 * The same shape of judgement as §SUB-DETECT, on the income side: presence in MOST of the covered
 * months (rhythm), and the MEDIAN of what arrived (so one bonus month does not set the expectation).
 *
 * ⚠️ A payday is claimed only with at least `MIN_MONTHS` sightings. Two is a coincidence: an
 * app that draws a salary arriving next Tuesday because two payments once landed on a Tuesday is
 * inventing income, and this is the one direction in which a wrong forecast does real damage.
 */
const PAYDAY_MIN_SHARE = 0.6;
const PAYDAY_MIN_MONTHS = 3;

export function detectPaydays(
  rows: { ym: string; dom: number; income: number }[],
): { dom: number; amount: number }[] {
  const months = [...new Set(rows.map((r) => r.ym))].sort();
  if (months.length < PAYDAY_MIN_MONTHS) return [];
  const byDom = new Map<number, { ym: string; income: number }[]>();
  for (const r of rows) {
    if (r.income <= 0) continue;
    const list = byDom.get(r.dom) ?? [];
    list.push(r);
    byDom.set(r.dom, list);
  }
  const out: { dom: number; amount: number }[] = [];
  for (const [dom, hits] of byDom) {
    const amounts = hits.map((h) => h.income);
    if (amounts.length < PAYDAY_MIN_MONTHS) continue;
    // ⚠️ The denominator runs from this day's FIRST sighting, not from the start of the window.
    // Someone who changed jobs four months ago is paid on the 20th every month SINCE, and judging
    // that against six months would refuse the most current fact in the data — while a day that
    // stopped a year ago is refused by the same rule, which is the half worth keeping.
    const since = months.filter((m) => m >= hits[0]!.ym).length;
    if (amounts.length / since < PAYDAY_MIN_SHARE) continue;
    const sorted = [...amounts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out.push({ dom, amount: Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) });
  }
  return out.sort((a, b) => a.dom - b.dom);
}

/**
 * Gather the canonical inputs and project. Lives here rather than in the route because every line
 * of it is a judgement — which history window, what counts as a typical day, which spending is
 * "ordinary" — and a route's job is to read a query string (C3 forced the same call for
 * `cashflowMoves` and `buildIncomeAnalytics`).
 */
export async function buildCashProjection(
  db: AppDb,
  rates: Rates,
  v: { mult: string; curFilter: string },
  window: { to: number; until: number },
  now = Math.floor(Date.now() / 1000),
): Promise<CashProjection> {
  const { to, until } = window;
  const analyticsRepo = await import("../../repo/analytics.ts");
  const { cashflowMoves } = await import("./cashflow.ts");
  const { domCounts, weekdayCounts } = await import("./weekday.ts");
  const { localMonthStart } = await import("./time.ts");

  // 90 days for the SHAPE and six months for the income rhythm: a weekday profile needs enough of
  // every weekday to be a profile, and a payday cannot be judged inside a single month.
  const shapeFrom = to - 90 * 86400;
  const rhythmFrom = localMonthStart(now, -5);
  const [domRows, dowRows, incomeRows, moves] = await Promise.all([
    analyticsRepo.spendByDom(db, v, { from: shapeFrom, to }, now, true),
    analyticsRepo.spendByWeekday(db, v, { from: shapeFrom, to }, now, true),
    analyticsRepo.incomeByDomMonth(db, v, { from: rhythmFrom, to }, now),
    cashflowMoves(db, rates, to, until),
  ]);

  // «Typical», never the raw sum, on both axes: a 90-day window holds five of some days and three
  // of others, and raw sums report that difference as behaviour (§WEEKDAY).
  const domDays = domCounts(shapeFrom, to);
  const dowDays = weekdayCounts(shapeFrom, to);
  const domProfile = new Array(31).fill(0) as number[];
  for (const r of domRows) if (domDays[r.dom - 1]) domProfile[r.dom - 1] = r.spent / domDays[r.dom - 1]!;
  const dowProfile = new Array(7).fill(0) as number[];
  for (const r of dowRows) if (dowDays[r.dow]) dowProfile[r.dow] = r.spent / dowDays[r.dow]!;

  const windowDays = Math.max(1, Math.round((to - shapeFrom) / 86400));
  // NOT rounded here. Rounding the daily figure and then scaling it across a month compounds the
  // error into the shape, and it makes the same projection in two bases differ by more than the
  // rate — which is what the §BASE-CUR sweep measures. One rounding, at the point of output.
  const ordinaryDaily = domRows.reduce((sum, r) => sum + r.spent, 0) / windowDays;

  const paydays = detectPaydays(incomeRows);
  const days = projectDays({
    after: to, until,
    // ⚠️ NOT converted again. `cashflowMoves` is handed the reader-base rate map, so §CUR-PLAN has
    // already expressed every charge in the reader's base — the parameter is named `rates` and its
    // unit follows whoever supplied it. Multiplying by `uahToBase` here converted twice, and on a
    // dollar screen that reads as a plausibly small subscription rather than as a broken chart.
    scheduled: moves.map((m) => ({ at: m.at, amount: Math.round(m.amount) })),
    ordinaryDaily, domProfile, dowProfile, paydays,
  });

  return {
    from: to, to: until, days, ordinary_daily: Math.round(ordinaryDaily),
    paydays: paydays.map((p) => p.dom),
    has_events: days.some((d) => d.scheduled > 0 || d.income > 0),
  };
}
