/**
 * Where this month ENDS — spend, income and the gap between them.
 *
 * Lifted out of the `/analytics/forecast` handler on 2026-08-21 when the analytics route hit its
 * C3 ceiling for the second time in one session. The line count is the trigger, not the argument:
 * every judgement below is about what a projection may honestly claim — how much to trust the
 * current pace against history, how wide the band is, and above all that §INCOME-PLAN asymmetry —
 * and judgement is `lib/` work. A route holding it is a route that will grow a second copy the
 * next time something else needs to know where the month lands.
 */
import type { Env } from "../../env.ts";
import type { Forecast } from "../../../shared/api/analytics.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import * as planningRepo from "../../repo/planning.ts";
import { getRates } from "./money.ts";
import { valueMode, localMonthStart, localParts } from "./stats.ts";
import { chargesBetween } from "./subscriptions.ts";
import { incomeOutlook } from "./income.ts";

export async function buildForecast(env: Env, now = Math.floor(Date.now() / 1000)): Promise<Forecast> {
  const monthStart = localMonthStart(now);
  const daysInMonth = Math.round((localMonthStart(now, 1) - monthStart) / 86400);
  const dayOfMonth = localParts(now).d; // 1..daysInMonth, у локальній зоні
  const daysElapsed = dayOfMonth;
  const daysRemaining = daysInMonth - dayOfMonth;

  const rates = await getRates(env);
  const { mult } = valueMode(rates, null); // forecast завжди зведено в базу читача
  // Трейлінг: до 3 ПОВНИХ місяців перед поточним — для історичного якоря прогнозу.
  const trailStart = localMonthStart(now, -3);
  const [totals, trail, planned, outlook] = await Promise.all([
    analyticsRepo.spendIncomeTotals(env.DB, { mult, curFilter: "" }, { from: monthStart, to: now }),
    analyticsRepo.monthlySpendBefore(env.DB, mult, now, trailStart, monthStart),
    planningRepo.activeWithTitles(env.DB),
    incomeOutlook(env, now),
  ]);

  const spend = totals?.spend ?? 0;
  const income = totals?.income ?? 0;
  const pace = daysElapsed > 0 ? spend / daysElapsed : 0;
  // Прогноз місяця = блендимо наївний темп (роздуває рано в місяці) з історичним якорем
  // (факт + середньомісячна історія на дні, що лишились). Рано довіряємо історії, під кінець —
  // фактичному темпу. Без історії — падаємо на чистий темп.
  const trailMonths = trail.map((r) => r.spend);
  const avgMonth = trailMonths.length ? trailMonths.reduce((s, v) => s + v, 0) / trailMonths.length : 0;
  const elapsedFrac = Math.min(1, Math.max(0.05, daysElapsed / daysInMonth));
  const paceProj = pace * daysInMonth;
  const histProj = spend + avgMonth * (daysRemaining / daysInMonth);
  const projectedSpend = avgMonth > 0
    ? Math.round(paceProj * elapsedFrac + histProj * (1 - elapsedFrac))
    : Math.round(paceProj);

  // Діапазон довіри: розкид (σ) місячних витрат історії, звужений на решту місяця (вже витрачене
  // — певне). Дає чесніший «12–15к» замість однієї цифри. Без історії — діапазон = точка.
  const sd = trailMonths.length > 1
    ? Math.sqrt(trailMonths.reduce((s, v) => s + (v - avgMonth) ** 2, 0) / trailMonths.length)
    : avgMonth * 0.15;
  const band = avgMonth > 0 ? Math.round(sd * (daysRemaining / daysInMonth) * 0.9) : 0;

  // Майбутні планові платежі, що спишуться до кінця місяця (інформативно).
  // §SUB-MONTH: розклад дає канонічний `chargesBetween` — тижневий план у залишку місяця
  // спишеться кілька разів, а власний однопрохідний цикл рахував рівно одне списання на план.
  // §CUR-PLAN: суми зводимо в базу — вони йдуть в один ряд із витратами місяця.
  const monthEnd = localMonthStart(now, 1);
  const upcomingItems = chargesBetween(planned, rates, now + 1, monthEnd - 1)
    .map((ch) => ({ title: ch.plan.title, amount: ch.amount, at: ch.at }));

  /**
   * §INCOME-PLAN — THIS is where the asymmetry gets fixed.
   *
   * `projectedNet` used to be `income(month-to-date) − projectedSpend(end of month)`: a fact minus
   * a forecast, which is guaranteed to look catastrophic on the 3rd and to "improve" as the month
   * passes without anything actually changing. Both halves now describe the same instant — the end
   * of the month — so the number finally answers the question it is labelled with.
   * ⚠️ `projectedIncome` is reported SEPARATELY as well, so the reader can see which half of the
   * net is money in the bank and which half is a plan. A single net figure would hide exactly the
   * uncertainty the owner flagged: income is not always the same, and not always on time.
   */
  const projectedIncome = income + outlook.expected_remaining;

  return {
    monthStart, now, daysInMonth, daysElapsed, daysRemaining,
    spend, income, pace: Math.round(pace),
    projectedSpend,
    projectedLow: Math.max(spend, projectedSpend - band),
    projectedHigh: projectedSpend + band,
    projectedIncome,
    incomeExpected: outlook.expected_remaining,
    incomeOverdue: outlook.overdue,
    incomeEstimated: outlook.estimated,
    projectedNet: projectedIncome - projectedSpend,
    upcomingPlanned: upcomingItems.reduce((s, p) => s + p.amount, 0),
    upcomingItems,
  };
}
