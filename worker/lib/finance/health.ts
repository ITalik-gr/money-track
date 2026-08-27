/**
 * §HEALTH — one score out of 100 for "how are my finances doing", from four weighted components.
 *
 * Split out of `lib/ai/advisor.ts` on 2026-08-27 under lint C3. The seam is real: that file builds
 * the PROSE payload a model reasons over, while this is arithmetic with thresholds — how many
 * months of cushion count as full marks, at what debt ratio the score reaches zero. It borrows the
 * funds breakdown and the canon and exports nothing back, so the import runs one way and the one
 * caller (the route) reaches it directly rather than through a re-export, which would close a
 * cycle (the same arrangement as `lib/ai/budget.ts`, and the reason `facts.ts` was split in August).
 *
 * ⚠️ §HEALTH-INCOME — the income series is ZERO-FILLED across the months the ledger covers. It used
 * to be built from `GROUP BY month`, which returns no row for a month with nothing coming in, with
 * a `> 0` filter on top: so both the average AND the stability score were taken over the months
 * that HAPPENED to have income, and **a jobless month made income look more stable**. The
 * stability component is 15% of the score, so the index rewarded the worst possible outcome by
 * pretending the month had not happened. Same class as §LEVEL-WINDOW, mirrored — one divided by a
 * window wider than the ledger, this by a window narrower than the truth.
 */
import type { Env } from "../../env.ts";
import type { FinanceHealth } from "../../../shared/api/analytics.ts";
import { fundsBreakdown } from "../ai/advisor.ts";
import { getRates } from "./money.ts";
import {
  STATS_JOINS, valueMode, incomeSum, spendSum, categoryMonthlyLevels, sumLevels,
  localMonthStart, localYm, localYmSql,
} from "./stats.ts";
import { coveredMonths } from "./levels.ts";
import { savingsRatePct } from "./finance.ts";
import { resolveLocale, st } from "../platform/i18n.ts";

export async function financeHealth(env: Env): Promise<FinanceHealth> {
  const now = Math.floor(Date.now() / 1000);

  const from6 = localMonthStart(now, -6);
  const monthStart = localMonthStart(now);
  // One snapshot for the whole answer (§D5) — health mixes funds with spending levels, and the
  // two halves resting on different rates would be a disagreement nobody could see.
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const [funds, levels, incomeRows] = await Promise.all([
    fundsBreakdown(env, rates),
    categoryMonthlyLevels(env, mult, { now }),
    // Дохід по ПОВНИХ місяцях (поточний частковий виключено) — для норми/стабільності.
    /**
     * Income AND spend, per complete month, from ONE query.
     *
     * ⚠️ The spend half is new (2026-08-27) and it fixes a real mismatch: the savings component
     * divided `(avgIncome − burn)` by `avgIncome`, i.e. it put a canonical LEVEL on one side of a
     * ratio and a raw average on the other. On the owner's ledger that displayed **−15%** where
     * actual-against-actual is **−5%** — a "savings rate" no other screen computes, under the same
     * name the Trends strip uses for the canonical one. `burn` is the right divisor for RUNWAY and
     * the wrong numerator here; §AI-AVGNAME states the general rule.
     */
    env.DB.prepare(
      `SELECT ${localYmSql(now)} AS m, ${incomeSum(mult)} AS income, ${spendSum(mult)} AS spend
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? GROUP BY m ORDER BY m`,
    ).bind(from6, monthStart).all<{ m: string; income: number; spend: number }>(),
  ]);

  const burn = sumLevels(levels); // ₴-мінор/міс (канон)

  /**
   * §HEALTH-INCOME (2026-08-27) — a month with NO income is a month, and it counts.
   *
   * `GROUP BY month` returns no row for a month with nothing coming in, and the old code then
   * filtered `> 0` on top of that. So both the average income AND the stability score were
   * computed over the months that HAPPENED to have income — which means **a jobless month made
   * income look more stable**, and the stability component (15% of the score) rewarded the worst
   * possible outcome by pretending the month did not exist.
   *
   * It is §LEVEL-WINDOW in a mirror: one divided by the window including months before the ledger,
   * this divided by only the months that were good. `coveredMonths` is now the single answer to
   * "which months does this account actually have", and both callers use it.
   */
  const keys: string[] = [];
  for (let i = 6; i >= 1; i--) keys.push(localYm(localMonthStart(now, -i)));
  const covered = await coveredMonths(env, keys);
  const byMonth = new Map((incomeRows.results ?? []).map((r) => [r.m, r]));
  // Zero-filled across the covered window — including a month with nothing, which is the point.
  const incomes = covered.map((k) => Math.max(0, byMonth.get(k)?.income ?? 0));
  const spends = covered.map((k) => Math.max(0, byMonth.get(k)?.spend ?? 0));
  const avgSpend = spends.length ? spends.reduce((s, v) => s + v, 0) / spends.length : 0;

  const mean = incomes.length ? incomes.reduce((s, v) => s + v, 0) / incomes.length : 0;
  const avgIncome = mean;
  const runway = burn > 0 ? funds.cushion / burn : (funds.cushion > 0 ? 12 : 0);
  // §savingsRatePct — the canon, which returns `null` for a month with no income rather than 0
  // («0% заощаджено» is a verdict, and a month without income cannot be graded). The health score
  // has to produce a number regardless, so it reads that null as the floor DELIBERATELY and says
  // so here — rather than by writing a fourth spelling of the ratio, which is what this was.
  const savingsPct = savingsRatePct(Math.round(avgIncome), Math.round(avgSpend));
  const savingsRate = savingsPct == null ? 0 : savingsPct / 100;
  const debtRatio = avgIncome > 0 ? funds.debt / avgIncome : (funds.debt > 0 ? 3 : 0);
  const cv = mean > 0 && incomes.length > 1
    ? Math.sqrt(incomes.reduce((s, v) => s + (v - mean) ** 2, 0) / incomes.length) / mean : 0;

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const sRunway = clamp01(runway / 6);          // 6 міс подушки = максимум
  const sSavings = clamp01(savingsRate / 0.2);  // 20%+ = максимум
  const sDebt = funds.debt <= 0 ? 1 : clamp01(1 - debtRatio / 3); // 3 міс доходу боргу = 0
  const sStable = clamp01(1 - cv);
  const score = Math.round((sRunway * 0.35 + sSavings * 0.30 + sDebt * 0.20 + sStable * 0.15) * 100);
  const band: FinanceHealth["band"] = score >= 70 ? "good" : score >= 45 ? "ok" : "risk";

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // Labels and hints are rendered as-is by `HealthIndexCard`/`HealthMini`, so they follow the
  // reader's locale like any other UI string (B3).
  const loc = await resolveLocale(env);
  return {
    score, band,
    components: [
      { key: "runway", label: st(loc, "healthRunway"), value: runway >= 12 ? st(loc, "healthMonthsMax") : st(loc, "healthMonths", { n: Math.round(runway * 10) / 10 }), score: Math.round(sRunway * 100), hint: st(loc, "healthRunwayHint") },
      { key: "savings", label: st(loc, "healthSavings"), value: pct(savingsRate), score: Math.round(sSavings * 100), hint: st(loc, "healthSavingsHint") },
      { key: "debt", label: st(loc, "healthDebt"), value: funds.debt <= 0 ? st(loc, "healthNoDebt") : st(loc, "healthDebtRatio", { n: Math.round(debtRatio * 10) / 10 }), score: Math.round(sDebt * 100), hint: st(loc, "healthDebtHint") },
      /**
       * ⚠️ The DISPLAYED value is `sStable`, the clamped one the score uses — not `1 − cv`.
       *
       * `cv` is unbounded, so a spiky income (freelance: nothing for five months, then one large
       * payment) gives `cv ≈ 2.2` and the card printed **«-124%»** as a stability percentage. It
       * became reachable the moment §HEALTH-INCOME started counting the empty months, which is the
       * fix that made the figure honest — and it would have shipped a number that reads as a
       * rendering bug to exactly the people whose income is the least stable.
       */
      { key: "stability", label: st(loc, "healthStability"), value: pct(sStable), score: Math.round(sStable * 100), hint: st(loc, "healthStabilityHint") },
    ],
  };
}
