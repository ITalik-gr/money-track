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
import type { BudgetStatusRow } from "../../../shared/api/planning.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "./categories-i18n.ts";
import * as budgetsRepo from "../../repo/budgets.ts";
import { getRates, uahToBase, hryvniaMult } from "./money.ts";
import {
  STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, EFF_AMOUNT, amountSum,
  categoryMonthlyLevels, projectSpend, localMonthStart, localYm,
} from "./stats.ts";

/**
 * The envelope's state, as the API declares it (`shared/api/planning.ts`).
 *
 * ⚠️ It was declared a SECOND time right here, with its own doc comments and the same fields —
 * the exact defect lints C2/C4 exist for, and invisible while the two copies happened to agree.
 * They stopped agreeing the moment §BUDGET-REACH added a field: `tsc` caught it only because the
 * ROUTE carries `satisfies`, i.e. one layer further out than where the drift was.
 */
export type BudgetStatus = BudgetStatusRow;

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
  env: Env, now = Math.floor(Date.now() / 1000),
): Promise<{ ym: string; closed: number }> {
  // §BASE-CUR: a CLOSED month is a record, so it is written in hryvnia — the unit the limits it
  // sits beside are stored in. Using the reader's display multiplier would make the archive say
  // dollars in the months a dollar reader happened to trigger the cron, and hryvnia in the rest.
  const mult = await hryvniaMult(env);
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

/**
 * How far under the level a limit has to sit before it counts as unreachable rather than as a
 * deliberate squeeze. 15%: a stretch target is a legitimate thing to set, and a banner on every
 * envelope someone tightened on purpose is a banner nobody reads.
 */
const REACH_MARGIN = 0.15;

export async function budgetStatus(
  env: Env, mult: string, now = Math.floor(Date.now() / 1000),
): Promise<BudgetStatus[]> {
  // §P3.4 / §LANG-ARCH: a category name leaving for the client is resolved in the READER's
  // locale. This query shipped without it, and the result was visible: the envelope grid said
  // «Транспорт» and «Продукти» on a screen that was English everywhere else — including the
  // donut two blocks above, which reads the same categories through `catNameSql`. One concept,
  // two resolutions, diverging exactly where the reader can see both at once.
  const locale = await resolveLocale(env);
  // §BASE-CUR: the LIMIT is stored in hryvnia (`budgets.amount` has no currency column) while the
  // SPEND beside it is rolled up into the reader's base. Comparing them un-converted is not a
  // rounding error — it is a 41× wrong percentage on a dollar screen. One factor, applied to
  // every stored figure that enters this function.
  const uah = uahToBase(await getRates(env));
  const inBase = (minorUah: number) => Math.round(minorUah * uah);
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
    const baseAmount = inBase(b.amount);
    const carried = inBase(carryFrom(prevMonth.get(b.id), b.amount) * (rollover ? 1 : 0));
    // The effective limit. `carryFrom` clamps at −base, so this cannot go negative; it CAN be
    // exactly zero, which is the honest reading of "last month you spent this month's money too".
    const amount = baseAmount + carried;
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
    const usual = lv?.level ?? baseAmount;
    const projected = projectSpend(spent, usual, elapsedFrac, lumpy);
    // A zero envelope has nothing to project INTO: "you are heading for 300 ₴ in a category you
    // said you would not spend in" is a forecast about a decision, not about a pace. The breach is
    // already reported by `ratio`, and `draftBudgetForecast` skips anything already at ratio ≥ 0.9,
    // so this keeps the two from describing the same hryvnia twice.
    const ratio = zero ? (spent > 0 ? 1 : 0) : spent / denom;
    return {
      id: b.id, name: b.name,
      amount, base_amount: baseAmount, carried, rollover,
      spent, ratio,
      projected, projected_ratio: zero ? ratio : projected / denom, lumpy,
      level: lv?.level ?? null,
      /**
       * §BUDGET-REACH (2026-08-27) — the app set a limit BELOW the level it itself computes.
       *
       * Not "you overspend": the canonical level is this app's own statement of what the category
       * costs per month, so a limit under it is the app disagreeing with itself and then reporting
       * the user as the one at fault, every month, forever.
       *
       * The real case: «Комуналка і звʼязок» limited at 1 087 against real months of
       * 1 246 / 1 285 / 2 531 / 1 458. The auto-budget set that limit AT the level — and the level
       * was understated 1.5× by the bug §LEVEL-WINDOW fixed. The envelope has read «153%
       * перевищено» ever since, for a target that is arithmetically unreachable.
       *
       * ⚠️ Reported, never auto-corrected. A limit is a DECISION — possibly a deliberate cut — and
       * silently raising it would discard the user's own work, the same rule as §RULES-UI apply,
       * §SIMILAR and the §AI-AUDIT revert guard. The screen offers the number; the person accepts it.
       * ⚠️ A ZERO envelope is never unreachable: «сюди я свідомо не витрачаю» is a plan, not a
       * miscalculation, and every level above zero would otherwise flag it (§BUDGET-ZERO).
       * ⚠️ Needs ≥2 months of real activity behind the level: one month is an anecdote, and the
       * same threshold `trackRecord` uses for the record it reads.
       */
      unreachable: !zero && lv != null && lv.active_months >= 2
        && lv.level > baseAmount * (1 + REACH_MARGIN),
    };
  });
}

// ---- §BUDGET-MEMORY: does the plan actually hold? ---------------------------

/**
 * `budget_months` has held the answer since migration 0043 and nobody could ask the question.
 *
 * Its two readers each took a slice and threw the rest away: `trackRecord` reduces a category to
 * a ratio so the auto-budget knows whether to trim, and the category page draws six months of ONE
 * envelope. Neither answers «чи я тримаю план» — the question a person actually has about a
 * budget, and the only one that distinguishes «зараз 70%» from «стає краще».
 *
 * ⚠️ **Everything here is stored in HRYVNIA and converted on the way out** (§BASE-CUR). A closed
 * month is an archive, so it is written in hryvnia deliberately; the reader may be looking at
 * dollars. This was already leaking: `budget_history` on `/categories/:id/overview` returned
 * `limit_minor`/`spent_minor` raw, so the strip under a converted envelope was in a different
 * currency than the envelope above it. The sweep in `currency-sweep.test.ts` could not see it,
 * because the fixture has no closed months for the field to appear in.
 */
export interface ClosedMonth {
  month: string;
  limit: number;
  spent: number;
  /** Closed inside the envelope. A zero limit is kept only by spending nothing. */
  kept: boolean;
}

export interface BudgetHistoryCategory {
  category_id: number;
  name: string;
  color: string | null;
  closed: number;
  over: number;
  avg_limit: number;
  avg_spent: number;
  /**
   * Consecutive kept months counting back from the MOST RECENT close, 0 if that one was blown.
   *
   * Counting back rather than the best run ever: the question is «чи я тримаю це зараз», and a
   * five-month streak from last spring answers a question nobody asked.
   */
  streak: number;
  months: ClosedMonth[];
}

export interface BudgetHistory {
  /** Whole-plan totals per closed month, oldest first. */
  months: (ClosedMonth & { envelopes: number; kept_envelopes: number })[];
  categories: BudgetHistoryCategory[];
  /** Envelope-months kept ÷ envelope-months closed, 0–100. `null` when nothing has closed yet. */
  kept_pct: number | null;
  /** How many distinct months are in the record — the honest denominator for everything above. */
  months_closed: number;
}

/**
 * Assemble the whole-plan track record over the last `monthsBack` closed months.
 *
 * ⚠️ The window is bounded by the MONTH KEY, like `trackRecord`, and for the same reason: a row
 * limit would have to guess how many envelopes exist, and the guess would silently decide how far
 * back the history reaches.
 * ⚠️ A month with no closed rows produces no entry rather than a zero one. §BUDGET-MEMORY only
 * starts accumulating when the feature is switched on, so a zero-filled axis would draw months of
 * apparent perfect discipline before any envelope existed.
 */
export async function budgetHistory(
  env: Env, monthsBack = 12, now = Math.floor(Date.now() / 1000),
): Promise<BudgetHistory> {
  const locale = await resolveLocale(env);
  const uah = uahToBase(await getRates(env));
  const inBase = (minorUah: number) => Math.round(minorUah * uah);
  const rows = await budgetsRepo.monthsSince(
    env.DB, locale, localYm(localMonthStart(now, -monthsBack)),
  );

  const byCat = new Map<number, BudgetHistoryCategory>();
  const byMonth = new Map<string, ClosedMonth & { envelopes: number; kept_envelopes: number }>();
  let kept = 0;

  for (const r of rows) {
    // The limit that was in force: the base plus whatever it carried in. Comparing spending
    // against today's limit is a verdict the data cannot support — the limit may have changed.
    const limit = inBase(r.limit_minor + r.carry_in_minor);
    const spent = inBase(r.spent_minor);
    const held = spent <= limit;
    if (held) kept++;

    const cat = byCat.get(r.category_id) ?? {
      category_id: r.category_id, name: r.name, color: r.color,
      closed: 0, over: 0, avg_limit: 0, avg_spent: 0, streak: 0, months: [],
    };
    cat.closed++;
    if (!held) cat.over++;
    cat.avg_limit += limit;
    cat.avg_spent += spent;
    cat.months.push({ month: r.ym, limit, spent, kept: held });
    byCat.set(r.category_id, cat);

    const m = byMonth.get(r.ym) ?? { month: r.ym, limit: 0, spent: 0, kept: true, envelopes: 0, kept_envelopes: 0 };
    m.limit += limit;
    m.spent += spent;
    m.envelopes++;
    if (held) m.kept_envelopes++;
    byMonth.set(r.ym, m);
  }

  for (const cat of byCat.values()) {
    cat.avg_limit = Math.round(cat.avg_limit / cat.closed);
    cat.avg_spent = Math.round(cat.avg_spent / cat.closed);
    for (let i = cat.months.length - 1; i >= 0 && cat.months[i].kept; i--) cat.streak++;
  }
  // The month verdict is about the PLAN as a whole, so it is the sum against the sum: an envelope
  // blown by 200 ₴ while another came in 900 ₴ under is a month that held, and counting envelopes
  // instead would call it a failure. `kept_envelopes` is carried alongside for the finer reading.
  for (const m of byMonth.values()) m.kept = m.spent <= m.limit;

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  return {
    months,
    categories: [...byCat.values()].sort((a, b) => b.avg_spent - a.avg_spent),
    kept_pct: rows.length ? Math.round((kept / rows.length) * 100) : null,
    months_closed: months.length,
  };
}
