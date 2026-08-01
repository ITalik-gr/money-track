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
import { getRates } from "./finance.ts";
import { STATS_JOINS, INCOME_WHERE, incomeSum, valueMode, localMonthStart, localYm } from "./stats.ts";

/** Тип цілі — від нього залежить, ЯК читати прогрес, а не лише як його підписати. */
export const GOAL_KINDS = ["save_up", "debt_payoff", "sinking_fund"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Правило авто-поповнення. NULL у колонці = вимкнено. */
export const AUTOFILL_KINDS = ["fixed", "income_pct"] as const;
export type AutofillKind = (typeof AUTOFILL_KINDS)[number];

export const isGoalKind = (v: unknown): v is GoalKind => GOAL_KINDS.includes(v as GoalKind);
export const isAutofillKind = (v: unknown): v is AutofillKind => AUTOFILL_KINDS.includes(v as AutofillKind);

/** `current_amount` = сума внесків. ЄДИНИЙ писар цієї колонки. */
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
  const rates = await getRates(env.DB);
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
