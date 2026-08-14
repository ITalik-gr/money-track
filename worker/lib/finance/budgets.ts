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
import * as budgetsRepo from "../../repo/budgets.ts";
import {
  STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, EFF_AMOUNT, amountSum,
  categoryMonthlyLevels, projectSpend, localMonthStart, localYm,
} from "./stats.ts";

export interface BudgetStatus {
  id: number;
  name: string;
  /**
   * ЕФЕКТИВНИЙ ліміт місяця, ₴-мінор = `base_amount + carried`.
   *
   * §BUDGET-MEMORY: the carry is folded in HERE, in the canon, rather than added by each reader.
   * Everything downstream — the envelope grid, `draftBudgets`, the weekly Telegram push, the AI
   * snapshot — asks "how much of the envelope is left" and gets one answer. The alternative was
   * what actually shipped for ten months: `budgets.rollover` existed since migration 0017, this
   * function never read it, and the Plan page derived a carry of its own in the CLIENT. So the
   * plan screen and the envelope grid quoted different limits for the same envelope.
   */
  amount: number;
  /** Ліміт, ЯК ЙОГО ВВЕЛИ, без перенесеного залишку. */
  base_amount: number;
  /**
   * Перенесено з минулого місяця, ₴-мінор. **Може бути ВІД'ЄМНИМ** — перевитрата переїжджає так
   * само, як і залишок, і саме ця симетрія робить конверт конвертом, а не м'яким побажанням.
   *
   * Віддається окремим полем, бо конверт мусить уміти сказати, ЗВІДКИ в нього ці гроші: ліміт,
   * що сам собою виріс на 800 ₴, читається як помилка застосунку.
   */
  carried: number;
  /** Прапорець `budgets.rollover` — чи бере цей конверт залишок минулого місяця. */
  rollover: boolean;
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

/**
 * Скільки минулий місяць передає в наступний, ₴-мінор.
 *
 * ⚠️ **Стеля ±базовий ліміт, і вона симетрична.** Без верхньої конверт, у якому шість місяців
 * поспіль економили, роздувається до суми, яка вже нічого не обмежує, — це не бюджет, а лічильник
 * заслуг. Без нижньої один катастрофічний місяць ховає конверт на пів року, і людина просто
 * перестає в нього дивитись. Один місяць запасу в кожен бік — це найбільше, що число може нести й
 * лишатись осмисленим.
 */
function carryFrom(prev: budgetsRepo.BudgetMonth | undefined, base: number): number {
  // Немає закритого місяця — немає перенесення. Вивести його заднім числом із транзакцій було б
  // легко й було б неправильно: ліміт минулого місяця ніде не зберігався, тож «перенесено 800 ₴»
  // означало б «перенесено за СЬОГОДНІШНІМ лімітом», і кожна правка ліміту мовчки переписувала б
  // історію. Порожньо — чесніше за вигадане.
  if (!prev) return 0;
  const left = prev.limit_minor + prev.carry_in_minor - prev.spent_minor;
  return Math.max(-base, Math.min(base, left));
}

/** Канонічна витрата за вікном, згрупована по ефективній категорії (₴-мінор, додатна). */
async function spendBetween(env: Env, mult: string, from: number, to: number) {
  const r = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}`,
  ).bind(from, to).all<{ id: number | null; spent: number }>();
  const m = new Map<number, number>();
  for (const row of r.results ?? []) if (row.id != null) m.set(row.id, row.spent);
  return m;
}

/**
 * §BUDGET-MEMORY — записати місяць, що ЩОЙНО скінчився, і тим самим продовжити ланцюг перенесень.
 *
 * Живе в ДОБОВОМУ проході, не в місячному. Місячний крон ходить рівно раз, 1-го числа: якщо саме
 * той прогін упав (виснажений ключ, збій, юзер створився 2-го), місяць не закрився б НІКОЛИ, а
 * ланцюг перенесень обірвався б назавжди — при тому що обидва конверти виглядали б нормально.
 * Добовий прохід із `INSERT OR IGNORE` самолікується: перший запуск після зміни місяця пише рядок,
 * решта — no-op.
 *
 * ⚠️ **Закриваємо ЛИШЕ попередній місяць, старіші не добираємо.** Ліміт за той місяць ніде не
 * зберігався, тож добір писав би сьогоднішній ліміт у позаминулий вересень — історія, яка виглядає
 * як виміряна, а насправді вигадана. Хто не заходив три місяці, починає ланцюг заново; смуга
 * історії наростає з цього моменту.
 */
export async function closeBudgetMonths(
  env: Env, mult: string, now = Math.floor(Date.now() / 1000),
): Promise<{ ym: string; closed: number }> {
  const monthStart = localMonthStart(now);
  const prevStart = localMonthStart(now, -1);
  const ym = localYm(prevStart);
  if (await budgetsRepo.monthIsClosed(env.DB, ym)) return { ym, closed: 0 };

  const [envelopes, spent, before] = await Promise.all([
    budgetsRepo.monthlyEnvelopes(env.DB),
    // `monthStart - 1`: вікно закінчується ОСТАННЬОЮ секундою минулого місяця. `monthStart` сам
    // належить новому місяцю, і транзакція, що впала рівно опівночі 1-го, порахувалась би двічі.
    spendBetween(env, mult, prevStart, monthStart - 1),
    budgetsRepo.closedMonth(env.DB, localYm(localMonthStart(now, -2))),
  ]);

  const rows: budgetsRepo.BudgetMonth[] = [];
  for (const [categoryId, e] of envelopes) {
    rows.push({
      ym, category_id: categoryId,
      limit_minor: e.amount,
      carry_in_minor: e.rollover ? carryFrom(before.get(categoryId), e.amount) : 0,
      spent_minor: spent.get(categoryId) ?? 0,
    });
  }
  await budgetsRepo.closeMonth(env.DB, rows, now);
  return { ym, closed: rows.length };
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

  const [budgets, spend, shape, levels, prevMonth] = await Promise.all([
    env.DB.prepare(
      `SELECT b.category_id AS id, b.amount AS amount, COALESCE(b.rollover, 0) AS rollover,
              ${catNameSql(locale, "c.name")} AS name
       FROM budgets b JOIN categories c ON c.id = b.category_id
       WHERE b.period = 'month' AND b.amount >= 0`,   // §BUDGET-ZERO: a 0 row IS an envelope
    ).all<{ id: number; amount: number; rollover: number; name: string }>(),
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
    // The month that just closed — the only place a carry may come from (`carryFrom`).
    budgetsRepo.closedMonth(env.DB, localYm(localMonthStart(now, -1))),
  ]);

  const spentByCat = new Map<number, number>();
  for (const r of spend.results ?? []) if (r.id != null) spentByCat.set(r.id, r.spent);
  const shapeByCat = new Map<number, { n: number; biggest: number }>();
  for (const r of shape.results ?? []) if (r.id != null) shapeByCat.set(r.id, { n: r.n, biggest: r.biggest });

  return (budgets.results ?? []).map((b) => {
    const spent = spentByCat.get(b.id) ?? 0;
    const sh = shapeByCat.get(b.id) ?? { n: 0, biggest: spent };
    const lv = levels.get(b.id);
    const rollover = !!b.rollover;
    const carried = rollover ? carryFrom(prevMonth.get(b.id), b.amount) : 0;
    // The effective limit. `carryFrom` clamps at −base, so this cannot go negative; it CAN be
    // exactly zero, which is the honest reading of "last month you spent this month's money too".
    const amount = b.amount + carried;
    /**
     * §BUDGET-ZERO — a limit of 0 is a real limit, and it needs its own arithmetic.
     *
     * Dividing by a floored denominator would make "spent 0 of 0" come out as **0%**, which the UI
     * draws as an untouched envelope with room in it. But a zero envelope holding at zero is the
     * only envelope that is perfectly kept, and rendering the best possible outcome as an empty
     * bar is the opposite of what the user asked the app to track.
     * So: nothing spent → ratio 0 and the UI reads `base_amount === 0` to say "нічого не
     * витрачено"; anything spent → ratio 1+, because a single hryvnia has already broken the only
     * promise this envelope makes. There is no "80% of nothing".
     */
    const zero = amount === 0;
    const denom = Math.max(amount, 1);
    // The SAME lump rule as the pace radar (`/analytics/patterns`): spending concentrated in one
    // or two large operations (tax, rent, a tank of fuel) is a fact that already happened, not a
    // rate to multiply by the days left. A fixed cost not yet charged this month is the mirror
    // case — nothing to extrapolate from, but the money is still coming.
    const lumpy = (spent > 0 && (sh.n <= 1 || sh.biggest >= spent * 0.55)) || (spent === 0 && !!lv?.fixed);
    // The envelope's own limit is the fallback level: a category can carry a budget without enough
    // history for `categoryMonthlyLevels`, and projecting against zero would call every such
    // envelope safe. The BASE limit, not the effective one — the level is a statement about how
    // much this category usually costs, and a carry-over says nothing about that.
    const usual = lv?.level ?? b.amount;
    const projected = projectSpend(spent, usual, elapsedFrac, lumpy);
    // A zero envelope has nothing to project INTO: "you are heading for 300 ₴ in a category you
    // said you would not spend in" is a forecast about a decision, not about a pace. The breach is
    // already reported by `ratio`, and `draftBudgetForecast` skips anything already at ratio ≥ 0.9,
    // so this keeps the two from describing the same hryvnia twice.
    const ratio = zero ? (spent > 0 ? 1 : 0) : spent / denom;
    return {
      id: b.id, name: b.name,
      amount, base_amount: b.amount, carried, rollover,
      spent, ratio,
      projected, projected_ratio: zero ? ratio : projected / denom, lumpy,
    };
  });
}
