// Response shapes of `/api/planned/*`, `/api/budgets/*` and `/api/goals/*`.
// Money is INTEGER minor units. See `./analytics.ts` for why this file exists.
import type { PlannedPayment } from "../types.ts";

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
  /**
   * §AI-RECURRING — this candidate came from the MODEL looking at a single charge, not from a
   * rhythm in the history. It is a guess, it is labelled as one on screen, and it exists because
   * the deterministic detector cannot say anything until the second month — by which time the
   * person has forgotten signing up.
   */
  ai?: boolean;
}

/**
 * §SUB-FIND — what the "describe it and I'll find it" search returns.
 *
 * `terms` travels back so the screen can say WHAT was searched for. Without it a screenful of
 * unrelated merchants reads as a broken search rather than as a search for the wrong word — which
 * is exactly how «X підписка» → OnTaxi looked.
 */
export interface AiDetectResult {
  terms: string[];
  candidates: {
    title: string; period_amount: number; currency_code: number; n: number;
    last_time?: number; category_id?: number | null; avg_interval_days: number;
  }[];
  error?: string;
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
  /** §BUDGET-REACH — the canonical monthly level for this category, ₴ minor. Null without history. */
  level: number | null;
  /**
   * §BUDGET-REACH — the limit sits meaningfully BELOW the level the app itself computes, i.e. the
   * target cannot be met by arithmetic, not by discipline. Reported, never auto-corrected: a limit
   * is a decision, and `level` travels alongside so the screen can offer the number.
   */
  unreachable: boolean;
}
export type BudgetStatusList = BudgetStatusRow[];

/**
 * `GET /budgets/history` — §BUDGET-MEMORY, read as a record rather than as a carry.
 *
 * All amounts are in the reader's base (`budget_months` stores hryvnia, the canon converts).
 */
export interface ClosedBudgetMonth { month: string; limit: number; spent: number; kept: boolean }

export interface BudgetHistoryCategoryRow {
  category_id: number; name: string; color: string | null;
  closed: number; over: number; avg_limit: number; avg_spent: number;
  /** Kept months counting back from the latest close — 0 if the latest one was blown. */
  streak: number;
  months: ClosedBudgetMonth[];
}

export interface BudgetHistory {
  months: (ClosedBudgetMonth & { envelopes: number; kept_envelopes: number })[];
  categories: BudgetHistoryCategoryRow[];
  /** Envelope-months kept, 0–100. `null` when nothing has closed — young, not failing. */
  kept_pct: number | null;
  months_closed: number;
}

/**
 * §GOAL-CHART — `GET /goals/:id/progress`. One shape for BOTH goal kinds: a manual goal's
 * cumulative contributions and a jar's account balance are resolved into the same series on the
 * server, so the client draws one thing and knows nothing about the difference.
 */
export interface GoalProgressSeries {
  points: { at: number; amount: number }[];
  /** True when the series came from an account balance rather than from contributions. */
  is_jar: boolean;
  /** §GOAL-CUR — the unit of every `amount` above: the goal's own, never the display base. */
  currency_code: number;
}

/**
 * `GET /planned` — the plans table, plus the ONE derived figure the page kept re-deriving.
 *
 * §SUB-MONTH says the monthly burden of a plan is `monthlyPlannedUAH` and nothing else, and the
 * reason it says so is a complaint from the owner: the app quoted two different figures for his
 * own subscriptions. That fix corrected the five SERVER sums and left the Subscriptions page
 * computing its own — with a rule that had since drifted, because `isFinished` there only ends
 * an `installment`, while the canon ends anything whose `end_date` has passed. A cancelled
 * subscription with an end date was therefore worth its full amount on that page and zero
 * everywhere else.
 *
 * ⚠️ `monthly_base` is in the READER's base, already averaged over the plan's period. Do not
 * multiply `period_amount` by anything in a component.
 */
export type PlannedRow = PlannedPayment & { monthly_base: number };

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

/**
 * §GOAL-CUR — `amount` is in the GOAL's currency, and the row says which so nobody has to guess.
 * `goal_contributions` has no currency column because it does not need one: these rows are summed
 * into the goal's `current_amount`, so they are that goal's unit by construction.
 */
export interface GoalContribution { id: number; amount: number; at: number; note: string | null; source: string; currency_code: number }

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
  /**
   * §GOAL-CUR (migration 0048) — the currency THIS goal's money is in, and the one every figure
   * on it is already expressed in. Not the display base: a jar funded in dollars is dollars, and
   * converting it into ₴ to sit beside a target typed as «2 000» is how the app came to
   * congratulate the owner on a goal that was 5% complete.
   */
  currency_code: number;
}

/**
 * §SUB-PAGE — one subscription with the analytics a decision about it needs.
 *
 * `*_base` is the reader's display currency (§BASE-CUR); `period_amount`, `last_amount` and each
 * charge's `amount` stay in the currency actually billed, because a price rise is only visible
 * there — an exchange-rate move is not the biller charging more.
 */
export interface SubscriptionOverview {
  plan: {
    id: number; title: string; kind: string; period: string; period_count: number;
    period_amount: number | null; currency_code: number;
    category_id: number | null; category_name: string | null;
    note: string | null; start_date: number; end_date: number | null;
    is_active: boolean; monthly_base: number;
  };
  next_charge: { at: number; in_days: number } | null;
  actual: {
    n: number; first_time: number | null; last_time: number | null;
    total_base: number; avg_base: number | null;
    last_amount: number | null; last_currency: number | null;
    price_change_pct: number | null;
    /**
     * §RHYTHM — the MEDIAN gap between real charges, not the mean across the whole span. One
     * missing charge used to turn a monthly plan into «кожні ~41 дн». Null under two charges.
     */
    real_interval_days: number | null; declared_interval_days: number;
    /** The day of the month it bills on, when the charges agree on one — the answer a person can check. */
    billing_day: number | null;
    /** Gaps ≥1.5× the median: a month the biller skipped, or a charge nothing linked to the plan. */
    skipped_gaps: number;
  };
  /**
   * §PRICE-STEPS — every price this subscription has been billed at, oldest first, in the BILLING
   * currency. The card can only say "the last charge vs the declared amount"; this says when the
   * price actually moved and by how much, which is the question behind "чи подорожчала".
   * A single entry means the price has never changed.
   */
  price_steps: { amount: number; currency_code: number; since: number; n: number }[];
  charges: { id: string; time: number; amount: number; currency_code: number; amount_base: number }[];
  share: { of_subscriptions_pct: number | null; of_category_pct: number | null; of_burn_pct: number | null };
  annual_base: number;
  category_monthly_base: number | null;
}
