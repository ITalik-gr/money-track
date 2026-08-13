/**
 * §BUDGET-FORECAST — envelopes: how much of a limit is eaten, and where the month is heading.
 *
 * Its own file rather than a section of `stats.ts` (moved 2026-08-12, forced by lint C3 and right
 * on its own terms): `stats.ts` holds the DEFINITIONS the whole app shares — what counts as
 * spending, which category a row rolls up to, how a period is bounded. An envelope is a FEATURE
 * built on those definitions, exactly like `weekday.ts`, `habits.ts`, `networth.ts` and `goals.ts`.
 *
 * Why the single source existed in the first place: the same "limit vs spent" pair used to be
 * computed in TWO places — the notification feed (`notify.draftBudgets`) canonically, and the
 * weekly Telegram push (`proactive.overBudget`) with its own SQL. That second one ignored splits,
 * did not subtract compensations or handle refunds, threw away every foreign-currency expense
 * instead of converting it, and skipped neither bucket 13 nor the real-category roll-up of a
 * withdrawal. Telegram therefore quoted a different number for the same budget than the app did.
 * Both paths call this function now, so there is nowhere left to diverge.
 */
import type { Env } from "../../env.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "./categories-i18n.ts";
import {
  STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, EFF_AMOUNT, amountSum,
  categoryMonthlyLevels, projectSpend, localMonthStart,
} from "./stats.ts";

export interface BudgetStatus {
  id: number;
  name: string;
  /** ліміт місяця, ₴-мінор */
  amount: number;
  /** витрачено з початку місяця, ₴-мінор (канон) */
  spent: number;
  /** spent / amount; ≥1 = перевитрата */
  ratio: number;
  /**
   * §BUDGET-FORECAST — де місяць закриється при цьому темпі, ₴-мінор.
   *
   * A budget without this is a rear-view mirror: "over limit" arrives on the day nothing can be
   * done about it. The projection is the SAME `projectSpend` the Patterns screen uses — one
   * definition of "where this is heading", so the envelope and the pace radar cannot disagree.
   */
  projected: number;
  /** projected / amount; ≥1 = піде за межу, якщо нічого не змінити */
  projected_ratio: number;
  /**
   * The projection was NOT extrapolated (a lump already landed, or a fixed cost has not been paid
   * yet this month). Exposed rather than hidden: `projected === spent` means two very different
   * things, and a UI that cannot tell them apart would present "on track" for a rent payment that
   * simply has not gone out yet.
   */
  lumpy: boolean;
}

export async function budgetStatus(
  env: Env, mult: string, now = Math.floor(Date.now() / 1000),
): Promise<BudgetStatus[]> {
  // §P3.4 / §LANG-ARCH: a category name leaving for the client is resolved in the READER's
  // locale. This query shipped without it, and the result was visible: the envelope grid said
  // «Транспорт» and «Продукти» on a screen that was English everywhere else — including the
  // donut two blocks above, which reads the same categories through `catNameSql`. One concept,
  // two resolutions, diverging exactly where the reader can see both at once.
  const locale = await resolveLocale(env);
  const monthStart = localMonthStart(now);
  const nextMonthStart = localMonthStart(now, 1);
  const elapsedFrac = Math.min(1, Math.max(0.02, (now - monthStart) / (nextMonthStart - monthStart)));

  const [budgets, spend, shape, levels] = await Promise.all([
    env.DB.prepare(
      `SELECT b.category_id AS id, b.amount AS amount, ${catNameSql(locale, "c.name")} AS name
       FROM budgets b JOIN categories c ON c.id = b.category_id
       WHERE b.period = 'month' AND b.amount > 0`,
    ).all<{ id: number; amount: number; name: string }>(),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart, now).all<{ id: number | null; spent: number }>(),
    // How this month's spend is SHAPED, which is what decides whether extrapolating it is honest.
    // `COUNT(DISTINCT t.id)` — `STATS_JOINS` multiplies a split row into its parts, and counting
    // rows would make one split purchase look like several (§SPLIT).
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, COUNT(DISTINCT t.id) AS n, MAX(-${EFF_AMOUNT} * ${mult}) AS biggest
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart, now).all<{ id: number | null; n: number; biggest: number }>(),
    categoryMonthlyLevels(env, mult, { now }),
  ]);

  const spentByCat = new Map<number, number>();
  for (const r of spend.results ?? []) if (r.id != null) spentByCat.set(r.id, r.spent);
  const shapeByCat = new Map<number, { n: number; biggest: number }>();
  for (const r of shape.results ?? []) if (r.id != null) shapeByCat.set(r.id, { n: r.n, biggest: r.biggest });

  return (budgets.results ?? []).map((b) => {
    const spent = spentByCat.get(b.id) ?? 0;
    const sh = shapeByCat.get(b.id) ?? { n: 0, biggest: spent };
    const lv = levels.get(b.id);
    // The SAME lump rule as the pace radar (`/analytics/patterns`): spending concentrated in one
    // or two large operations (tax, rent, a tank of fuel) is a fact that already happened, not a
    // rate to multiply by the days left. A fixed cost not yet charged this month is the mirror
    // case — nothing to extrapolate from, but the money is still coming.
    const lumpy = (spent > 0 && (sh.n <= 1 || sh.biggest >= spent * 0.55)) || (spent === 0 && !!lv?.fixed);
    // The envelope's own limit is the fallback level: a category can carry a budget without enough
    // history for `categoryMonthlyLevels`, and projecting against zero would call every such
    // envelope safe.
    const usual = lv?.level ?? b.amount;
    const projected = projectSpend(spent, usual, elapsedFrac, lumpy);
    return {
      id: b.id, name: b.name, amount: b.amount, spent, ratio: spent / b.amount,
      projected, projected_ratio: projected / b.amount, lumpy,
    };
  });
}
