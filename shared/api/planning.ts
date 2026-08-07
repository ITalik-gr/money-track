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

export type GoalKind = "save_up" | "debt_payoff" | "sinking_fund";
export type AutofillKind = "fixed" | "income_pct";

/** Тіло створення/редагування цілі. Одна форма на обидві мутації — вони приймають те саме. */
export interface GoalBody {
  name: string; target_amount: number; current_amount?: number;
  account_id?: string | null; deadline?: number | null; color?: string; note?: string;
  kind?: GoalKind; autofill_kind?: AutofillKind | null; autofill_value?: number | null;
}

export interface GoalContribution { id: number; amount: number; at: number; note: string | null; source: string }

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
  current: number; // ефективний прогрес (баланс банки або ручний)
}
