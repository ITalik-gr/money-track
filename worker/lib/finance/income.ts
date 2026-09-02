/**
 * §INCOME-PLAN — what is still expected to come IN, and what was due and has not.
 *
 * The asymmetry this exists to fix: both `/analytics/safe-to-spend` and `/analytics/forecast`
 * computed `income − spend` where the spend half was projected forward (`chargesBetween`,
 * `projectSpend`) and the income half was month-to-date history. One subtraction, two different
 * kinds of number. Early in a month that reads as "you have nothing free" while a whole month of
 * subscriptions is already deducted — the app at its most pessimistic exactly when it is most
 * looked at, and permanently wrong for anyone whose income arrives in irregular lumps.
 *
 * ⚠️ **Expected income is NEVER added to `income`.** The canon (`INCOME_WHERE`, `incomeSum`) counts
 * money that actually arrived, and it keeps doing so. An unpaid invoice folded into "your income"
 * is the failure that makes a finance app actively harmful: it is the number people spend against.
 * This module returns expected as its own quantity and every caller renders it as its own quantity.
 *
 * ⚠️ **Lateness is DERIVED, not tracked per invoice.** `overdue = scheduled-so-far − received`,
 * compared as totals. The alternative is matching each expected payment to a real transaction, and
 * a matcher that misses marks money the user actually has as missing — a total cannot. It also
 * survives the owner's real constraint: income is neither the same size nor on time, so an
 * unplanned payment or a different amount simply closes the gap, which is what happened in life.
 */
import type { Env } from "../../env.ts";
import * as planningRepo from "../../repo/planning.ts";
import { getRates } from "./money.ts";
import { chargesBetween } from "./subscriptions.ts";
import { localMonthStart, localYm, valueMode, STATS_JOINS, INCOME_WHERE, incomeSum } from "./stats.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { st, type ServerLocale } from "../platform/i18n.ts";
import type { IncomeAnalytics } from "../../../shared/api/analytics.ts";

export interface IncomeOutlook {
  /** Actually arrived since the 1st, ₴ minor — the canon, unchanged. */
  received: number;
  /** Still scheduled between now and the end of the month, ₴ minor. */
  expected_remaining: number;
  /** Scheduled to have arrived by now, ₴ minor. */
  expected_to_date: number;
  /**
   * Scheduled by now but not seen: `max(0, expected_to_date − received)`.
   * A separate number rather than a subtraction inside `expected_remaining`, because "late" and
   * "still coming" call for different reactions — one is a question for a client, the other is
   * just the calendar.
   */
  overdue: number;
  /** True when any contributing plan is flagged as varying — the totals are estimates. */
  estimated: boolean;
  /** The individual upcoming payments, soonest first. */
  items: { id: number; title: string; at: number; amount: number; varies: boolean }[];
}

export async function incomeOutlook(
  env: Env, now = Math.floor(Date.now() / 1000),
): Promise<IncomeOutlook> {
  const monthStart = localMonthStart(now);
  const monthEnd = localMonthStart(now, 1);

  const [rates, plans] = await Promise.all([
    getRates(env),
    planningRepo.activeIncomePlans(env.DB),
  ]);
  const { mult } = valueMode(rates, null);

  // The canon decides what "received" means — refunds, transfers and bucket 13 are already
  // excluded there (§REFUND), and re-deriving it here is how two screens start disagreeing.
  const got = await env.DB.prepare(
    `SELECT ${incomeSum(mult)} AS income
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${INCOME_WHERE}`,
  ).bind(monthStart, now).first<{ income: number }>();
  const received = got?.income ?? 0;

  // `chargesBetween` expands a plan into dated occurrences and converts currency (§CUR-PLAN), so a
  // retainer invoiced in USD lands in ₴ like everything else. Same function as the expense side —
  // an income schedule that drifted from the expense schedule would be the §SUB-MONTH bug again.
  const toDate = chargesBetween(plans, rates, monthStart, now);
  const remaining = chargesBetween(plans, rates, now + 1, monthEnd - 1);
  const sum = (xs: { amount: number }[]) => xs.reduce((s, c) => s + c.amount, 0);

  const expected_to_date = sum(toDate);
  const expected_remaining = sum(remaining);

  return {
    received,
    expected_remaining,
    expected_to_date,
    overdue: Math.max(0, expected_to_date - received),
    // Flagged if ANY contributing plan varies: one uncertain figure makes the total uncertain, and
    // a total presented as exact because the other three plans were fixed would be worse than no
    // total at all.
    estimated: plans.some((p) => !!p.amount_varies),
    items: remaining.map((ch) => ({
      id: ch.plan.id,
      title: ch.plan.title,
      at: ch.at,
      amount: ch.amount,
      varies: !!ch.plan.amount_varies,
    })),
  };
}

/**
 * The `/analytics/income` payload, assembled out of the canon.
 *
 * Moved out of the route on 2026-09-02 under C3: the handler's own job is to read a window out of
 * a query string, and everything below — which rows count as a source, how a period compares to
 * the one before, what "stable income" means — is a domain judgement. Same seam, same argument as
 * `cashflowMoves`.
 */
export async function buildIncomeAnalytics(
  db: AppDb,
  locale: ServerLocale,
  v: { mult: string; curFilter: string },
  bounds: { from: number; to: number; prevFrom: number; prevTo: number },
  preset: string,
  now = Math.floor(Date.now() / 1000),
): Promise<IncomeAnalytics> {
  const { from, to, prevFrom, prevTo } = bounds;
  const analyticsRepo = await import("../../repo/analytics.ts");

  const [sources, curTot, prevTot, monthly] = await Promise.all([
    analyticsRepo.incomeBySource(db, locale, v, { from, to }),
    analyticsRepo.incomeTotal(db, v, { from, to }),
    analyticsRepo.incomeTotal(db, v, { from: prevFrom, to: prevTo }),
    // 6 календарних місяців для оцінки стабільності (по місяцях).
    analyticsRepo.monthlyIncome(db, v, now, { from: localMonthStart(now, -5), to: now }),
  ]);

  const total = curTot?.income ?? 0;
  const prevTotal = prevTot?.income ?? 0;
  const deltaPct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : (total > 0 ? null : 0);

  const srcRows = sources.map((s) => ({
    category_id: s.category_id, name: s.name ?? st(locale, "other"), color: s.color,
    amount: s.amount, n: s.n, pct: total > 0 ? Math.round((s.amount / total) * 100) : 0,
  }));

  // Стабільність: коеф. варіації (stddev/mean) по ПОВНИХ місяцях (без поточного часткового).
  const nowMonth = localYm(now);
  const complete = monthly.filter((r) => r.m !== nowMonth).map((r) => r.income);
  let cvPct: number | null = null, label = st(locale, "stabilityUnknown");
  if (complete.length >= 2) {
    const mean = complete.reduce((a, b) => a + b, 0) / complete.length;
    if (mean > 0) {
      const variance = complete.reduce((a, b) => a + (b - mean) ** 2, 0) / complete.length;
      cvPct = Math.round((Math.sqrt(variance) / mean) * 100);
      label = st(locale, cvPct <= 15 ? "stabilityStable" : cvPct <= 40 ? "stabilityModerate" : "stabilityVolatile");
    }
  }

  return {
    period: { from, to, preset: preset as IncomeAnalytics["period"]["preset"] },
    total, prev_total: prevTotal, delta_pct: deltaPct,
    sources: srcRows,
    monthly: monthly.map((r) => ({ month: r.m, income: r.income })),
    stability: { cv_pct: cvPct, label },
  };
}
