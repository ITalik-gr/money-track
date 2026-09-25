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
import type { FinanceHealth, HealthParts } from "../../../shared/api/analytics.ts";
import { fundsBreakdown } from "../ai/advisor.ts";
import { getRates, type Rates } from "./money.ts";
import { healthTrend } from "../../repo/health.ts";
import { valueMode, categoryMonthlyLevels, sumLevels, localYmd } from "./stats.ts";
import { monthlyFlowSeries, incomeCv } from "./flow-series.ts";
import { savingsRatePct } from "./finance.ts";
import { resolveLocale, st } from "../platform/i18n.ts";

export async function financeHealth(env: Env, ratesIn?: Rates): Promise<FinanceHealth> {
  const now = Math.floor(Date.now() / 1000);

  // One snapshot for the whole answer (§D5) — health mixes funds with spending levels, and the
  // two halves resting on different rates would be a disagreement nobody could see.
  const rates = ratesIn ?? await getRates(env);
  const { mult } = valueMode(rates, null);
  const [funds, levels, flow] = await Promise.all([
    fundsBreakdown(env, rates),
    categoryMonthlyLevels(env, mult, { now }),
    // Income AND spend per complete covered month, zero-filled — §FLOW-SERIES, the one definition.
    // Spend is here because savings compares FACT with fact: it once divided `(avgIncome − burn)`
    // by `avgIncome`, a canonical level against a raw average, and showed −15% where the truth was
    // −5% (§AI-AVGNAME states the general rule).
    monthlyFlowSeries(env, mult, now),
  ]);

  const burn = sumLevels(levels); // ₴-мінор/міс (канон)
  const { incomes, spends } = flow;
  const h = scoreHealth({ cushion: funds.cushion, burn, debt: funds.debt, incomes, spends });

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // Labels and hints are rendered as-is by `HealthIndexCard`/`HealthMini`, so they follow the
  // reader's locale like any other UI string (B3).
  const loc = await resolveLocale(env);
  const part = (k: HealthKey) => h.parts.find((p) => p.key === k)!;
  const comp = (k: HealthKey, label: string, value: string, hint: string) => {
    const p = part(k);
    return {
      key: k, label, hint,
      // An unmeasured part says so in words; a «0%» there would be a verdict on data that is not there.
      value: p.s == null ? st(loc, "healthNotEnough") : value,
      score: p.s == null ? 0 : Math.round(p.s * 100),
      weight: p.weight, points: p.points, measured: p.s != null,
    };
  };
  const { runway, savingsRate, debtRatio } = h;
  return {
    score: h.score, band: h.band, insufficient: h.insufficient,
    components: [
      comp("runway", st(loc, "healthRunway"), runway >= 12 ? st(loc, "healthMonthsMax") : st(loc, "healthMonths", { n: Math.round(runway * 10) / 10 }), st(loc, "healthRunwayHint")),
      comp("savings", st(loc, "healthSavings"), pct(savingsRate), st(loc, "healthSavingsHint")),
      comp("debt", st(loc, "healthDebt"), funds.debt <= 0 ? st(loc, "healthNoDebt") : st(loc, "healthDebtRatio", { n: Math.round(debtRatio * 10) / 10 }), st(loc, "healthDebtHint")),
      /**
       * ⚠️ The DISPLAYED value is `sStable`, the clamped one the score uses — not `1 − cv`.
       *
       * `cv` is unbounded, so a spiky income (freelance: nothing for five months, then one large
       * payment) gives `cv ≈ 2.2` and the card printed **«-124%»** as a stability percentage. It
       * became reachable the moment §HEALTH-INCOME started counting the empty months, which is the
       * fix that made the figure honest — and it would have shipped a number that reads as a
       * rendering bug to exactly the people whose income is the least stable.
       */
      comp("stability", st(loc, "healthStability"), pct(part("stability").s ?? 0), st(loc, "healthStabilityHint")),
    ],
  };
}

export type HealthKey = "runway" | "savings" | "debt" | "stability";

/**
 * The weights, named once and used twice — by the sum below and by the components it reports.
 *
 * They were literals inside the sum, which was fine while nobody outside could see them, and
 * stopped being fine the moment the card started printing how many of the 100 points each part
 * contributes: two spellings of 0.35 in two files is exactly the drift lints C2/C4 exist for,
 * and it would show up as a card whose four contributions do not add to the score above them.
 */
export const HEALTH_WEIGHTS: Record<HealthKey, number> = { runway: 0.35, savings: 0.30, debt: 0.20, stability: 0.15 };

/**
 * Below this much MEASURED weight the score is a guess, and the card says «попередня оцінка».
 * Runway (0.35) plus any one other part clears it; runway alone, or three small parts without it,
 * do not — a score that rests on a third of its formula should not read like the whole.
 */
const MIN_MEASURED_WEIGHT = 0.5;

export interface HealthInputs {
  /** Own liquid funds, base-currency minor units (`fundsBreakdown().cushion`). */
  cushion: number;
  /** The canonical monthly burn (`sumLevels`). */
  burn: number;
  debt: number;
  /** Income and spend per COMPLETE covered month, zero-filled (§HEALTH-INCOME). */
  incomes: number[];
  spends: number[];
}

export interface HealthPart {
  key: HealthKey;
  /** 0..1, or null when the data cannot measure it — excluded from the score, not graded as zero. */
  s: number | null;
  weight: number;
  /** Points out of 100 this part contributes; the parts sum EXACTLY to `score`. */
  points: number;
}

/**
 * §HEALTH — the arithmetic alone, with no database, so every edge can be pinned by a test.
 *
 * Audited 2026-09-25 against the owner's question «чи реально формула норм, і чи працює вона».
 * Two defects found, both of the §HEALTH-INCOME class (a missing thing graded as a good thing):
 *
 *  1. **No income at all read as PERFECTLY stable income.** `cv` was 0 when the mean was 0, so
 *     `1 − cv` gave stability 100%: six jobless months earned the component's full 15 points.
 *     Zero income is the least stable income there is — it now scores 0.
 *  2. **One month of history read as perfectly stable too** (a single value has no spread), and
 *     no months at all graded savings at 0% and debt at «3 months of income». Neither is a
 *     measurement. A part the data cannot measure is now UNMEASURED: it is left out and the other
 *     weights are renormalised, instead of lending the score a confident number it never had.
 *
 * And one presentation defect: the card rounded each part's points independently, so the four
 * numbers under the gauge could add to 1–2 points more or less than the gauge itself. The points
 * are now allocated by largest remainder, so they always sum to the score exactly.
 */
export function scoreHealth(i: HealthInputs): {
  score: number; band: FinanceHealth["band"]; parts: HealthPart[]; insufficient: boolean;
  runway: number; savingsRate: number; debtRatio: number;
} {
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const n = i.incomes.length;
  const mean = n ? i.incomes.reduce((s, v) => s + v, 0) / n : 0;
  const avgSpend = i.spends.length ? i.spends.reduce((s, v) => s + v, 0) / i.spends.length : 0;

  // Runway: an account with neither money nor spending has nothing to measure a runway from.
  const runway = i.burn > 0 ? i.cushion / i.burn : (i.cushion > 0 ? 12 : 0);
  const sRunway = i.burn <= 0 && i.cushion <= 0 ? null : clamp01(runway / 6);   // 6 міс подушки = максимум

  // §savingsRatePct — the canon, which returns `null` for a month with no income rather than 0
  // («0% заощаджено» is a verdict, and a month without income cannot be graded). Over covered
  // months with no income at all, the floor is read DELIBERATELY: that is a real six-month
  // outcome, not missing data. With no covered months there is nothing to read — unmeasured.
  const savingsPct = savingsRatePct(Math.round(mean), Math.round(avgSpend));
  const savingsRate = savingsPct == null ? 0 : savingsPct / 100;
  const sSavings = n === 0 ? null : clamp01(savingsRate / 0.2);                // 20%+ = максимум

  const debtRatio = mean > 0 ? i.debt / mean : (i.debt > 0 ? 3 : 0);
  const sDebt = i.debt <= 0 ? 1 : n === 0 ? null : clamp01(1 - debtRatio / 3); // 3 міс доходу боргу = 0

  const cv = incomeCv(i.incomes);   // §INCOME-CV — the one definition, shared with the income card
  const sStable = n < 2 ? null : mean <= 0 || cv == null ? 0 : clamp01(1 - cv);

  const raw: { key: HealthKey; s: number | null }[] = [
    { key: "runway", s: sRunway }, { key: "savings", s: sSavings },
    { key: "debt", s: sDebt }, { key: "stability", s: sStable },
  ];
  // Rounded: 0.35 + 0.30 + 0.20 + 0.15 is 1.0000000000000002 in floating point, and every weight
  // divided by it came out as 0.35000000000000003 on the wire.
  const measuredW = Math.round(raw.reduce((sum, r) => sum + (r.s == null ? 0 : HEALTH_WEIGHTS[r.key]), 0) * 1e9) / 1e9;
  // Exact contributions over the MEASURED weight, then largest-remainder rounding.
  const exact = raw.map((r) => (r.s == null || measuredW === 0 ? 0 : (r.s * HEALTH_WEIGHTS[r.key] / measuredW) * 100));
  const score = Math.round(exact.reduce((a, b) => a + b, 0));
  const floors = exact.map(Math.floor);
  let left = score - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((e, k) => ({ k, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) { if (left <= 0) break; floors[o.k]++; left--; }

  const band: FinanceHealth["band"] = score >= 70 ? "good" : score >= 45 ? "ok" : "risk";
  return {
    score, band, insufficient: measuredW < MIN_MEASURED_WEIGHT,
    // The weight REPORTED is the one the score actually used: renormalised over the measured parts,
    // 0 for an unmeasured one. With everything measured it is the constant itself; otherwise the
    // card's «got / max» would print a maximum the part could never have reached.
    parts: raw.map((r, k) => ({
      key: r.key, s: r.s, points: floors[k],
      weight: r.s == null || measuredW === 0 ? 0 : HEALTH_WEIGHTS[r.key] / measuredW,
    })),
    runway, savingsRate, debtRatio,
  };
}

/** The points of each MEASURED part, for `health_history` (§HEALTH-TREND). */
export function healthParts(h: Pick<FinanceHealth, "components">): HealthParts {
  const pts = (k: HealthKey) => {
    const c = h.components.find((x) => x.key === k);
    return c && c.measured ? c.points : null;
  };
  return { pts_runway: pts("runway"), pts_savings: pts("savings"), pts_debt: pts("debt"), pts_stability: pts("stability") };
}

/**
 * §HEALTH-AI — the index as the advisor and the chat receive it.
 *
 * The owner: «щоб цей індекс здоров'я використовувався для AI, щоб і вона розуміла мій стан діл».
 * It was not: the index existed only for the card, so the model reasoned about runway, savings and
 * debt one by one while the app's own summary of all three sat unused. Now it rides in the ONE
 * financial context (`collectFinanceSnapshot`, so chat = advisor = screens), computed by the same
 * `financeHealth` the card calls, on the same rates snapshot (§D5).
 *
 * ⚠️ The note tells the model what the number IS and what it may do with it. It may explain the
 * score through its parts and name the weakest; it may not recompute it, re-weight it or restate it
 * with a different value — and every number here is in the payload, so `numbersAreGrounded` holds
 * any figure the model quotes from it.
 */
export async function healthForModel(env: Env, rates: Rates): Promise<Record<string, unknown>> {
  const h = await financeHealth(env, rates);
  const now = Math.floor(Date.now() / 1000);
  let change30: number | null = null;
  try {
    // The score ~30 days ago: the earliest recorded day inside the window. Null with no history —
    // a missing past is not «unchanged».
    const trend = await healthTrend(env.DB, localYmd(now - 31 * 86400));
    if (trend.length >= 2) change30 = h.score - trend[0].score;
  } catch { /* table lag on a fresh deployment — the index itself still goes */ }
  return {
    health_index: {
      score: h.score, band: h.band, provisional: h.insufficient, change_30d: change30,
      parts: h.components.map((c) => ({
        part: c.key, value: c.value, points: c.measured ? c.points : null, max_points: Math.round(c.weight * 100),
      })),
    },
    health_note: "health_index is the app's own financial health score (0-100), the SAME number the user sees on their health card: band good ≥70, ok ≥45, risk below. It is a weighted sum of four parts — runway (months the liquid cushion lasts), savings (share of income kept, 20%+ is full marks), debt (debt against monthly income), stability (how even income is month to month); points/max_points is what each part contributes, and the parts add up to the score. Use it to orient the whole answer: name the band, and name the part with the biggest gap between points and max_points — that is where improvement pays most. change_30d is the move over about a month (null = no history yet). provisional=true means less than half the formula could be measured: say the score is preliminary. points=null means that part has too little data — say so, never call it zero. NEVER recompute, re-weight or restate the score with a different value.",
  };
}
