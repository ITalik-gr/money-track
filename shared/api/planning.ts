// Response shapes of `/api/planned/*`, `/api/budgets/*` and `/api/goals/*`.
// Money is INTEGER minor units. See `./analytics.ts` for why this file exists.

export interface UpcomingSubs {
  days: number; total: number;
  // §CUR-PLAN: `amount` — у валюті плану (показуємо як є, «$5»), `amount_uah` — зведення
  // для підсумків; `total` уже в ₴.
  items: { id: number; title: string; amount: number; currency_code: number; amount_uah: number; at: number; days_until: number }[];
}

/** A merchant that looks like a subscription but has no plan yet (`GET /planned/detect`). */
export interface RecurringCandidate {
  merchant: string;
  amount: number; // minor units, positive
  n: number;
  first_time: number;
  last_time: number;
  months: number;
  avg_interval_days: number;
  currency_code?: number;
  category_id?: number | null;
}

// Автобюджет: пропозиція лімітів із канонічного місячного рівня категорії. Копійки.
export interface AutoBudgetItem {
  category_id: number; name: string; color: string | null;
  importance: string; essential: boolean;
  level: number; suggested: number; current: number | null;
  /**
   * §BUDGET-MEMORY — WHY this number, so the UI never has to guess:
   *  · `essential` — rent/groceries, never trimmed (a cut you cannot make is a fake red bar);
   *  · `missed`    — the envelope was blown in half its closed months, so the trim is dropped;
   *  · `kept`      — there IS a record and it is good, so the trim stands;
   *  · `level`     — no closed month yet; the canonical monthly level alone.
   */
  basis: "essential" | "missed" | "kept" | "level";
  months_closed: number;
  months_over: number;
}
export interface AutoBudget { trim_pct: number; total_level: number; total_suggested: number; items: AutoBudgetItem[] }

// AI-план бюджетів (Sonnet) — пропозиція на КОЖНУ категорію з причиною.
export interface BudgetProposalRow {
  category_id: number;
  name: string;
  color: string | null;
  avg_month: number;
  current_limit: number;
  suggested: number;
  reason: string;
}
export interface BudgetPlanResult {
  rows: BudgetProposalRow[];
  overall: string;
  runway_months: number | null;
  generated_at: number;
}
export interface BudgetChatReply {
  reply: string;
  proposals?: { category_id: number; limit_uah: number; reason: string }[];
}

/**
 * `GET /budgets/status` — the envelope canon: limit, spent so far, and the month-end projection.
 * Shaped by `lib/finance/budgets.ts` `budgetStatus`; the client renders it and computes nothing.
 */
export interface BudgetStatusRow {
  id: number; name: string;
  /** §BUDGET-MEMORY: the EFFECTIVE limit — `base_amount + carried`. Ratios are against this. */
  amount: number;
  /** The limit as typed on the Plan page. */
  base_amount: number;
  /** Carried in from the month that just closed; NEGATIVE when it was overspent. */
  carried: number;
  rollover: boolean;
  spent: number; ratio: number;
  /** §BUDGET-FORECAST: where the month closes at this pace, ₴ minor. */
  projected: number;
  projected_ratio: number;
  /** The projection was deliberately NOT extrapolated (a lump landed, or a fixed cost is pending). */
  lumpy: boolean;
}
export type BudgetStatusList = BudgetStatusRow[];

/** `POST /planned/from-habit` — §HABITS row turned into a declared plan. */
export interface PlanFromHabit { ok: boolean; id: number }

export type GoalKind = "save_up" | "debt_payoff" | "sinking_fund";
export type AutofillKind = "fixed" | "income_pct";

/** Тіло створення/редагування цілі. Одна форма на обидві мутації — вони приймають те саме. */
export interface GoalBody {
  name: string; target_amount: number; current_amount?: number;
  account_id?: string | null; deadline?: number | null; color?: string; note?: string;
  kind?: GoalKind; autofill_kind?: AutofillKind | null; autofill_value?: number | null;
}

export interface GoalContribution { id: number; amount: number; at: number; note: string | null; source: string }

/**
 * §GOAL-PACE — is the goal going to make it. Computed on the SERVER (`lib/finance/goals.ts`,
 * `goalPace`), because the notification drafter reads the same answer: otherwise the card and the
 * feed would name different numbers about one goal, and one of them would look like a bug.
 */
export type GoalStatus = "done" | "no_deadline" | "on_track" | "behind" | "at_risk" | "overdue";

export interface GoalPace {
  status: GoalStatus;
  progress_frac: number;
  elapsed_frac: number | null;
  behind_frac: number | null;
  days_left: number | null;
  left: number;
  per_month: number | null;
}

export interface SavingsGoal {
  id: number;
  name: string;
  target_amount: number;
  current_amount: number;
  account_id: string | null;
  account_balance?: number | null;
  account_title?: string | null;
  deadline: number | null;
  color: string | null;
  note: string | null;
  // §P2.1 (міграція 0037). `kind` міняє суть прогресу: save_up накопичує, debt_payoff гасить
  // борг, sinking_fund не «закінчується» на досягненні суми. `autofill_*` — правило
  // щомісячного авто-внеску (NULL = вимкнено); `autofill_last_ym` — за який місяць уже нараховано.
  kind?: GoalKind;
  autofill_kind?: AutofillKind | null;
  autofill_value?: number | null;
  autofill_last_ym?: string | null;
  created_at?: number | null;
  current: number; // ефективний прогрес (баланс банки або ручний)
  pace: GoalPace;  // §GOAL-PACE — server-computed, so the card and the feed cannot diverge
}
