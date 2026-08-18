/**
 * §P2.1 — цілі: денормалізований прогрес і авто-поповнення (міграції 0036 + 0037).
 *
 * Тут живуть дві речі, які МУСЯТЬ мати рівно одного писаря:
 *  • `recalcGoal` — `savings_goals.current_amount` = SUM(`goal_contributions`). Перенесено з
 *    роутів, щойно зʼявився другий охочий писати цю суму (крон авто-поповнення). Те саме
 *    правило, що для §COMPENSATION: денормалізовану суму рухає одне місце, інакше вона
 *    розійдеться з джерелом і ніхто не помітить.
 *  • `runGoalAutofill` — щомісячний авто-внесок. Ідемпотентність за МІСЯЦЕМ
 *    (`autofill_last_ym`), а не за таймстампом: крон може прогнатись двічі (ретрай, ручний
 *    виклик), і з таймстампом другий прохід просто додав би ще один внесок.
 */
import type { Env } from "../../env.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { getRates } from "./money.ts";
import { STATS_JOINS, INCOME_WHERE, incomeSum, valueMode, localMonthStart, localYm } from "./stats.ts";

/** Тип цілі — від нього залежить, ЯК читати прогрес, а не лише як його підписати. */
export const GOAL_KINDS = ["save_up", "debt_payoff", "sinking_fund"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Правило авто-поповнення. NULL у колонці = вимкнено. */
export const AUTOFILL_KINDS = ["fixed", "income_pct"] as const;
export type AutofillKind = (typeof AUTOFILL_KINDS)[number];

export const isGoalKind = (v: unknown): v is GoalKind => GOAL_KINDS.includes(v as GoalKind);
export const isAutofillKind = (v: unknown): v is AutofillKind => AUTOFILL_KINDS.includes(v as AutofillKind);

/**
 * §GOAL-PACE — "is this goal going to make it", the SINGLE source.
 *
 * One question, answered in TWO places with different arithmetic: the goal card computed "how much
 * to save per month" in the CLIENT (`left / months`, month = 30.44 days), while `draftGoalRisk` in
 * `notify.ts` had its own (`need / (days / 30)`) — and only the second one knew anything about
 * falling behind, which the card never showed at all. So the feed could announce that a goal is
 * behind and name a monthly figure written down nowhere on the goal itself. Same mechanism as
 * §CUR-PLAN and §SUB-MONTH: one concept, two implementations.
 *
 * A pure function with no database access, which is exactly why both the route and the
 * notification drafter can use it.
 *
 * ⚠️ There is NO `per_month` when less than a month remains: a monthly rate is misleading there
 * ("save 30 000/mo" with seven days left), and the decision to show the remaining total instead
 * was taken on 2026-07-14 (DESIGN §8, P5). Whoever needs a number in that mode reads `left`.
 * ⚠️ The start is the goal's `created_at`, not its first contribution: a goal opened six months
 * ago and still empty is behind precisely BECAUSE nothing happened for six months. With no date
 * we assume 180 days before the deadline — the only assumption in here.
 */
export type GoalStatus = "done" | "no_deadline" | "on_track" | "behind" | "at_risk" | "overdue";

export interface GoalPace {
  status: GoalStatus;
  /** 0..1, capped at one. */
  progress_frac: number;
  /** 0..1 — how much of the window has passed. `null` when there is no window (no deadline). */
  elapsed_frac: number | null;
  /** How far time is ahead of money, as a fraction. `null` with no deadline. */
  behind_frac: number | null;
  days_left: number | null;
  /** Still to be saved, in minor units. */
  left: number;
  /** Minor units per month to make it. `null` in a sprint (<1 month) and with no deadline. */
  per_month: number | null;
}

/** Average month length. Not 30: over a year that difference is five whole days of rate. */
const MONTH_DAYS = 30.44;
/** The "time ran ahead of money" gap at which a goal counts as behind. */
const BEHIND_THRESHOLD = 0.15;
/** Past this point the question stops being "are you catching up" and becomes "will you make it". */
const SPRINT_DAYS = 7;

export function goalPace(
  g: { target_amount: number; current: number; deadline: number | null; created_at?: number | null },
  now = Math.floor(Date.now() / 1000),
): GoalPace {
  const target = g.target_amount;
  const left = Math.max(0, target - g.current);
  const progress_frac = target > 0 ? Math.min(g.current / target, 1) : 0;
  const base = { progress_frac, left };

  if (target > 0 && g.current >= target) {
    return { ...base, status: "done", elapsed_frac: null, behind_frac: null, days_left: null, per_month: null };
  }
  if (!g.deadline) {
    return { ...base, status: "no_deadline", elapsed_frac: null, behind_frac: null, days_left: null, per_month: null };
  }

  const days_left = Math.ceil((g.deadline - now) / 86400);
  const months_left = (g.deadline - now) / (86400 * MONTH_DAYS);
  // A monthly rate only outside the sprint — see the note above.
  const per_month = months_left >= 1 && left > 0 ? Math.round(left / months_left) : null;

  const start = g.created_at ?? g.deadline - 180 * 86400;
  // The window cannot be zero or negative (a deadline earlier than the goal's own creation):
  // dividing by it is impossible, and "behind" is meaningless for such a goal anyway — the
  // deadline itself is all that is left to report.
  const window = g.deadline - start;
  const elapsed_frac = window > 0 ? Math.min(Math.max((now - start) / window, 0), 1) : null;
  const behind_frac = elapsed_frac != null ? elapsed_frac - progress_frac : null;

  const status: GoalStatus =
    days_left < 0 ? "overdue"
      : days_left <= SPRINT_DAYS ? "at_risk"
        : (behind_frac ?? 0) >= BEHIND_THRESHOLD ? "behind"
          : "on_track";

  return { ...base, status, elapsed_frac, behind_frac, days_left, per_month };
}

/** Whether a goal is worth a line in the feed. The same gate `draftGoalRisk` used to hold itself. */
export const goalNeedsAttention = (p: GoalPace) =>
  p.status === "overdue" || p.status === "at_risk" || p.status === "behind";

/** `current_amount` = the sum of contributions. THE ONLY writer of this column. */
export async function recalcGoal(db: AppDb, goalId: number): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM goal_contributions WHERE goal_id = ?")
    .bind(goalId).first<{ s: number }>();
  const total = r?.s ?? 0;
  await db.prepare("UPDATE savings_goals SET current_amount = ? WHERE id = ?").bind(total, goalId).run();
  return total;
}

interface AutofillGoal {
  id: number; kind: string; target_amount: number; current_amount: number;
  account_id: string | null; autofill_kind: string | null; autofill_value: number | null;
  autofill_last_ym: string | null;
}

/**
 * Дохід ПОПЕРЕДНЬОГО повного місяця в ₴-копійках — база для правила «% від доходу».
 *
 * Саме попереднього, а не поточного: правило спрацьовує на початку місяця, коли поточний
 * місяць ще майже порожній, і відсоток від нього був би відсотком від випадкового залишку.
 * Канон (`INCOME_WHERE` + `incomeSum`), тож це та сама цифра, що показує Статистика.
 */
async function prevMonthIncome(env: Env, now: number): Promise<number> {
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const from = localMonthStart(now, -1);
  const to = localMonthStart(now);
  const r = await env.DB.prepare(
    `SELECT ${incomeSum(mult)} AS income FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${INCOME_WHERE}`,
  ).bind(from, to).first<{ income: number }>();
  return Math.max(0, r?.income ?? 0);
}

/**
 * Щомісячний авто-внесок у цілі. Викликає добовий крон; безпечно викликати частіше.
 *
 * Ціль-банку (`account_id`) свідомо пропускаємо: там джерело правди — баланс рахунку, який
 * веде банк, і ще один внесок поверх нього рахував би ті самі гроші двічі (той самий гейт
 * стоїть і на ручному внеску).
 */
export async function runGoalAutofill(
  env: Env, now = Math.floor(Date.now() / 1000),
): Promise<{ applied: number; total: number }> {
  const ym = localYm(now);   // §APP_TZ — місяць київський, як і скрізь
  const rows = await env.DB.prepare(
    `SELECT id, kind, target_amount, current_amount, account_id, autofill_kind, autofill_value, autofill_last_ym
     FROM savings_goals
     WHERE is_active = 1 AND account_id IS NULL AND autofill_kind IS NOT NULL
       AND COALESCE(autofill_last_ym, '') <> ?`,
  ).bind(ym).all<AutofillGoal>();
  const goals = rows.results ?? [];
  if (!goals.length) return { applied: 0, total: 0 };

  // Дохід тягнемо ЛИШЕ якщо є ціль на відсотку — це повний скан транзакцій за місяць.
  let income: number | null = null;
  let applied = 0;
  let total = 0;

  for (const g of goals) {
    let amount = 0;
    if (g.autofill_kind === "fixed") {
      amount = Math.max(0, Math.round(g.autofill_value ?? 0));
    } else if (g.autofill_kind === "income_pct") {
      income ??= await prevMonthIncome(env, now);
      const pct = Math.min(100, Math.max(0, g.autofill_value ?? 0));
      amount = Math.round((income * pct) / 100);
    }

    // Накопичувальну ціль не переливаємо через край: внесок обрізається залишком, а вже
    // зібрану ціль пропускаємо. `sinking_fund` — виняток за визначенням: це фонд під
    // регулярну майбутню витрату, він не «закінчується» на досягненні суми.
    if (g.kind !== "sinking_fund" && g.target_amount > 0) {
      amount = Math.min(amount, Math.max(0, g.target_amount - g.current_amount));
    }
    // Порожній місяць (нульовий дохід, ціль уже зібрана) — НЕ штампуємо `autofill_last_ym`:
    // штамп означає «за цей місяць нараховано», а нічого нараховано не було. Ціна — ще одна
    // перевірка завтра; альтернатива — мовчки пропущений місяць, якщо дохід прийшов 3-го числа.
    if (amount <= 0) continue;

    await env.DB.prepare(
      "INSERT INTO goal_contributions (goal_id, amount, at, note, source) VALUES (?, ?, ?, NULL, 'auto')",
    ).bind(g.id, amount, now).run();
    await env.DB.prepare("UPDATE savings_goals SET autofill_last_ym = ? WHERE id = ?").bind(ym, g.id).run();
    await recalcGoal(env.DB, g.id);
    applied++;
    total += amount;
  }
  return { applied, total };
}

/**
 * §GOAL-CHART — one progress series for ANY goal, whatever backs it.
 *
 * The roadmap card left this open with a real question: a manual goal grows from
 * `goal_contributions`, a jar-backed one has none — its progress IS the account balance, which
 * lives in `account_balance_history`. Two storages of the same idea.
 *
 * Resolved on the SERVER, into one shape. The alternative was two client paths, which is §CUR-PLAN
 * with a chart attached: the same quantity derived twice, drifting where the reader sees both at
 * once. The client now receives `{at, amount}[]` and draws it without knowing which kind it is.
 *
 * ⚠️ **A manual goal is CUMULATIVE, a jar is a LEVEL.** Contributions are deltas that must be
 * summed to become progress; a balance is already the progress. Summing balances would multiply
 * the jar's own money by the number of days it was recorded — a chart climbing to ten times the
 * target while the card underneath says 40%.
 * ⚠️ Both series are clipped to the goal's own start, so the flat stretch before the first money
 * stays visible: on a goal that is behind, that stretch is usually the entire explanation.
 */
export function goalProgressSeries(
  input: { created_at: number | null; deadline: number | null },
  contributions: { at: number; amount: number }[],
  jarBalances: { at: number; amount: number }[],
  isJar: boolean,
): { at: number; amount: number }[] {
  const start = input.created_at
    ?? (input.deadline != null ? input.deadline - 180 * 86400 : 0);

  if (isJar) {
    // Already a level: take it as it is, only bounded to the goal's window.
    return jarBalances.filter((p) => p.at >= start).map((p) => ({ at: p.at, amount: p.amount }));
  }

  let running = 0;
  const out: { at: number; amount: number }[] = [];
  for (const c of [...contributions].sort((a, b) => a.at - b.at)) {
    running += c.amount;
    // A withdrawal can push the running total below zero on a badly-kept goal; the chart's Y axis
    // starts at 0, so clamping here keeps the line inside the box instead of silently vanishing.
    out.push({ at: c.at, amount: Math.max(0, running) });
  }
  return out.filter((p) => p.at >= start);
}
