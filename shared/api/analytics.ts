// Response shapes of `/api/analytics/*` — the ONE declaration both sides use.
//
// Why this file exists (D2): the client used to hand-declare what it believed the server
// returned, while the worker declared its own shapes inline via `.all<{…}>()`. `tsc` saw two
// independent truths it could not reconcile, so a field renamed on one side surfaced only in
// production. Now the worker annotates its RETURN with these types and the client imports them,
// which is what makes the compiler — not a reviewer — the thing that notices drift.
//
// Money is INTEGER minor units unless a field says `_uah`/`_pct` (major / percent).
// Shapes are copied VERBATIM from the client's old declarations: phase 2 moves the contract, it
// does not change any response (ARCHITECTURE §7). A field that is wrong stays wrong and gets a card.

export type PeriodMode = "calendar" | "rolling";
export type Preset = "week" | "month" | "quarter" | "year";

/** Spend by effective category, rolled up into the parent, converted to ₴ (positive). */
export interface CategorySpend {
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  spent: number; // канонічно, зведено в ₴ (додатнє)
  n: number;
}

/**
 * Period totals.
 *
 * `n` was `null` rather than `0` on an empty account until 2026-08-07 — `SUM()` over an empty set
 * is NULL and `SPEND_COUNT` carried no `COALESCE`, so a new user's "operations" card rendered
 * blank. Fixed at the canon; the empty-account goldens pin it.
 */
export interface PeriodTotals { spend: number; income: number; n: number }

/**
 * `Overview.summary` plus the one derived figure the screens kept re-deriving.
 *
 * `savings_rate_pct` was computed in four places — the AI report, the Trends strip, the dashboard
 * pulse, and nowhere on the server. Identical arithmetic in all of them, and nothing that would
 * have said so on the day one of them changed (§CUR-PLAN, three times over).
 */
export interface PeriodSummary extends PeriodTotals { savings_rate_pct: number | null }

export interface Overview {
  summary: PeriodSummary;
  prev: PeriodTotals;
  range: { from: number; to: number; prevFrom: number; prevTo: number; bucket: string; mode: PeriodMode; preset: string | null };
  series: { bucket: string; spend: number; income: number }[];
  byCategory: { category_id: number | null; category_name: string | null; color: string | null; spent: number; n: number }[];
  byMerchant: { merchant: string; spent: number; n: number }[];
  byAccount: { account_id: string | null; account_title: string | null; account_type: string | null; spent: number; n: number }[];
  byEvent: { event_id: number; event_name: string; event_color: string | null; spent: number; n: number }[];
  byImportance: { importance: string; spent: number; n: number }[];
}

/**
 * §IMPORTANCE-TREND (2026-08-12): every month also carries the essential / discretionary /
 * optional split, so the long view can answer whether the OPTIONAL share is climbing.
 *
 * On the same rows rather than in a second array: it is the same months over the same window, and
 * two arrays would let a caller pair them up wrongly. The three add up to `spend` by construction
 * (`EFF_IMPORTANCE` defaults to `discretionary`, so no spending falls outside).
 */
export interface MonthlyHistory {
  months: {
    month: string; spend: number; income: number;
    /**
     * Share of that month's income that survived it, 0–100 (negative when it did not).
     * `null` when there was no income — a month with nothing coming in cannot be graded.
     */
     savings_rate_pct: number | null;
    essential: number; discretionary: number; optional: number;
  }[];
}

export interface SafeToSpend {
  /** §INCOME-PLAN — still scheduled to arrive before month end. NOT part of `safe`. */
  income_expected: number;
  /** Scheduled to have arrived by now and not seen. */
  income_overdue: number;
  /** A contributing income plan is flagged as varying, so the two figures above are estimates. */
  income_estimated: boolean;
  safe: number; income: number; spend: number; essential: number; discretionary: number;
  subs_monthly: number; subs_remaining: number; month_start: number;
}

export interface CapitalTrend {
  now_uah: number;
  points: { t: number; capital_uah: number }[];
}

// Нетворт у часі: активи (подушка + інвест) − борг, на кінець кожного місяця. Копійки.
// `ym` (`YYYY-MM`) — канонічний місяць точки. Підпис осі рахуємо з нього, а НЕ з `t`:
// `t` кінця місяця = 23:59:59 UTC, у Києві (+3) це вже 1-ше наступного місяця.
export interface NetworthPoint { t: number; ym: string; cushion: number; debt: number; investment: number; assets: number; net: number }
export interface Networth { months: number; points: NetworthPoint[]; now: NetworthPoint | null; caveats: string[] }

/**
 * `GET /analytics/fx-cost` — what currency conversion actually cost, over a window.
 *
 * Not a fee the bank ever prints: it is the gap between the rate applied to a purchase
 * (`amount ÷ original_amount`, both already stored) and the published rate of that day
 * (`rate_history`). Amounts are in the reader's base.
 */
export interface FxCostItem {
  id: string; at: number; merchant: string | null;
  original_amount: number; original_currency: number;
  charged: number; market: number; cost: number; cost_pct: number;
}

export interface FxCost {
  window: { from: number; to: number };
  n: number;
  /** Charged by the bank, and what the same purchases were worth at the published rate. */
  charged: number;
  market: number;
  cost: number;
  cost_pct: number | null;
  /** Rows with no published rate for their day — excluded rather than guessed. */
  unpriced: number;
  by_currency: { code: number; n: number; charged: number; market: number; cost: number; cost_pct: number }[];
  items: FxCostItem[];
}

export interface CompareBucket {
  from: number; to: number; spend: number; income: number;
  /** How many income events produced `income` — §CADENCE reads it, see `income_delta_meaningful`. */
  income_n: number;
}

/**
 * One category, in both windows at once.
 *
 * The merge used to happen in the CLIENT, in two components with a copy each. That was already
 * a second and third definition of «what changed», and neither could carry §CADENCE because the
 * charge counts never left the server. Merged rows come down whole now; sorting and slicing stay
 * with the screen, because those are presentation and the two tabs legitimately differ.
 */
export interface CompareRow {
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  /** Spend in window A (the later one) and in window B (the baseline). Minor units, reader's base. */
  a: number;
  b: number;
  delta: number;
  /** Charges behind `a` and `b` — the rhythm count (`SPEND_TX_COUNT`), not the row count. */
  n: number;
  prev_n: number;
  /**
   * §CADENCE: `false` means this delta is about the calendar, not about behaviour — a monthly
   * biller landed inside one window and outside the other. The row is still SHOWN (hiding it
   * would hide real money), but the percentage next to it is not a finding.
   */
  delta_meaningful: boolean;
}

export interface Compare {
  a: CompareBucket;
  b: CompareBucket;
  /** Every category present in either window, biggest side first. */
  rows: CompareRow[];
  /**
   * The biggest movers, decided HERE rather than on screen: the noise floor is a money amount and
   * therefore depends on the reader's base currency (§BASE-CUR), and the §CADENCE filter needs the
   * charge counts. Both were client-side constants until 2026-08-21, and the floor was a literal
   * `5000` minor units — 50 ₴ as intended, but $50 for anyone reading in dollars.
   */
  movers: { up: CompareRow[]; down: CompareRow[] };
  /** The window is shorter than a monthly billing cycle, so some deltas are muted. */
  short_period: boolean;
  /** §CADENCE for the income line: one salary a month cannot be compared week to week. */
  income_delta_meaningful: boolean;
}

export interface Forecast {
  /** §INCOME-PLAN — received so far PLUS what is still scheduled this month. */
  projectedIncome: number;
  incomeExpected: number;
  incomeOverdue: number;
  incomeEstimated: boolean;
  monthStart: number; now: number; daysInMonth: number; daysElapsed: number; daysRemaining: number;
  spend: number; income: number; pace: number;
  projectedSpend: number; projectedLow?: number; projectedHigh?: number; projectedNet: number;
  upcomingPlanned: number;
  upcomingItems: { title: string; amount: number; at: number }[];
}

export interface IncomeAnalytics {
  period: { from: number; to: number; preset: string };
  total: number; prev_total: number; delta_pct: number | null;
  sources: { category_id: number | null; name: string; color: string | null; amount: number; n: number; pct: number }[];
  monthly: { month: string; income: number }[];
  stability: { cv_pct: number | null; label: string };
}

// Cashflow-календар: очікувані списання по днях + стартова подушка (для проєкції балансу).
// §CUR-PLAN: `amount` — у ₴ (його сумують і віднімають від подушки), оригінал — у `amount_orig`.
export interface CashflowItem { at: number; date: string; title: string; amount: number; amount_orig: number; currency_code: number; category_id: number | null; kind: string }
export interface CashflowCalendar { from: number; to: number; now: number; cushion: number; items: CashflowItem[] }

export interface ReceiptItemsAnalytics {
  items: { name: string; total: number; qty: number; n: number }[];
  receipts: number; total_items: number;
}

// §E4: дрейф цін / персональна інфляція по позиціях чеків.
export interface PriceDrift {
  window: { from: number; to: number };
  basket_change_pct: number | null;
  tracked: number;
  items: { name: string; first_unit: number; last_unit: number; change_pct: number; n: number; first_at: number; last_at: number }[];
}

// §E1/E2/E3: детерміновані патерни витрат цього місяця.
export interface PaceItem {
  category: string; color: string | null; spent: number;
  oneoff: number; mostly_oneoff: boolean; lumpy: boolean;
  projected: number; usual: number; pct: number | null;
}
export interface SpendPatterns {
  period: { from: number; to: number; elapsed_frac: number };
  recurring: {
    ref_from: number;
    recurring: { spent: number; n: number };
    oneoff: { spent: number; n: number };
    oneoff_items: { merchant: string | null; category: string | null; amount: number; time: number }[];
  };
  anomalies: PaceItem[];
  pace: PaceItem[];
}

/** A row in any drill-down list. Deliberately narrower than `TxRow` — a drill shows context, not the feed. */
export interface DrillTx {
  id: string; time: number; amount: number; currency_code: number; merchant: string | null;
  comment: string | null; user_note?: string | null; category_name?: string | null; category_color?: string | null;
}
export interface CategoryDrill {
  subs: { category_id: number | null; name: string; color: string | null; spent: number; n: number }[];
  merchants: { merchant: string; spent: number; n: number }[];
  transactions: DrillTx[];
}
export interface SliceDrill { spent: number; n: number; transactions: DrillTx[] }

// §H: детермінований Індекс фінздоров'я (без AI) — 4 складові + зважений скор 0..100.
export interface HealthComponent { key: string; label: string; value: string; score: number; hint: string }
export interface FinanceHealth { score: number; band: "good" | "ok" | "risk"; components: HealthComponent[]; trend?: { day: string; score: number }[] }

// Спарклайни: 6-міс місячні витрати (копійки) на категорію (ключ=id) і мерчанта (ключ=назва).
export interface SparkData { buckets: string[]; categories: Record<string, number[]>; merchants: Record<string, number[]> }

/**
 * §WEEKDAY — where the money goes by day of the week.
 *
 * `dow` follows SQL `strftime('%w')`: 0 = Sunday. `days` is how many such days the window
 * actually contained, and it is the field that makes the row honest — a month holds five Fridays
 * and four Saturdays, so "Saturday is cheaper" may only mean "there were fewer Saturdays".
 * `typical` is `spent / days`, computed server-side so both the UI and the AI read one number.
 */
export interface WeekdaySpend {
  dow: number;
  spent: number;   // ₴-копійки, канонічно (додатнє)
  n: number;       // операцій
  days: number;    // скільки таких днів тижня було у вікні
  typical: number; // spent / days, ₴-копійки
  /**
   * The day's total rests on ONE payment (≤1 operation, or the biggest is ≥55% of it).
   *
   * The same threshold `projectSpend` uses, and for the same reason: rent landing on a Sunday
   * does not make Sunday an expensive day — it makes Sunday the day rent was due. Without this
   * the headline reads "Sundays cost 4× a Tuesday" off a single standing charge.
   */
  lumpy: boolean;
}
export interface WeekdayAnalytics {
  from: number; to: number;
  days: WeekdaySpend[];       // завжди 7 рядків, dow 0..6
  /** dow with the highest `typical`, LUMPY DAYS EXCLUDED; null when nothing qualifies. */
  busiest: number | null;
  weekend_share_pct: number | null; // частка сб+нд у витратах вікна
}

/**
 * §WEEKDAY along the other axis — `GET /analytics/day-of-month`.
 *
 * `days` always has 31 entries. `typical` divides by how many times that date OCCURRED in the
 * window, which is the whole point: in any window that is not a whole number of months the 31st
 * shows up fewer times than the 15th, and raw sums report that as thrift.
 */
export interface DomSpend {
  dom: number; spent: number; n: number; days: number; typical: number;
  /** Carried by one payment — rent on the 1st is a due date, not a spending habit. */
  lumpy: boolean;
}
export interface DomAnalytics {
  from: number; to: number;
  days: DomSpend[];
  busiest: number | null;
  /** How much of the window's spending left in days 1–5, where standing charges cluster. */
  first_five_share_pct: number | null;
}

/**
 * §HABITS — a merchant that joined your regular spending, or that went quiet.
 *
 * `monthly` is the average over the months it was ACTUALLY charged, not over the window: a
 * merchant that started two months ago would otherwise look three times cheaper than it is.
 * `since`/`last` are `YYYY-MM` so the UI can say "since March" without re-deriving a month from
 * a timestamp — the mistake CLAUDE.md records as making charts label the wrong month.
 */
export interface HabitChange {
  merchant: string;
  months: number;   // скільки місяців вікна він реально списувався
  monthly: number;  // ₴-копійки, середнє за ті місяці
  since: string;    // YYYY-MM
  last: string;     // YYYY-MM
}
export interface Habits {
  started: HabitChange[];
  stopped: HabitChange[];
  started_monthly_total: number; // ₴-копійки/міс, скільки додали НОВІ регулярні разом
}

/** `GET /analytics/currencies` — ISO codes present in the data, ascending. Bare numbers, no rows. */
export type CurrenciesList = number[];

// §P3: сторінка мерчанта — агрегати по одному мерчанту.
export interface MerchantAnalytics {
  name: string;
  total: number;                 // копійки, ₴ — уся історія витрат
  n: number;
  avg: number;                   // копійки, середній чек
  first_at: number | null;
  last_at: number | null;
  by_month: { month: string; spent: number }[];
  top_category: { name: string; color: string | null; spent: number } | null;
  category_share: number | null; // % витрат категорії, що припадає на мерчанта
  transactions: import("./transactions.ts").TxRow[];
}

/**
 * `GET /categories/:id/overview` — the deterministic half of the category page.
 *
 * Deliberately separate from `CategoryDrill` (which the Stats tab already uses for sub-categories,
 * merchants and operations): this carries the things a PAGE needs and a drill panel does not — the
 * canonical monthly level, the twelve-month trend, the envelope state and the one-off / recurring
 * split. Two shapes rather than one bloated one, so the Stats tab keeps paying for only what it
 * renders.
 */
export interface CategoryOverview {
  id: number;
  name: string;
  color: string | null;
  /** `EFF_IMPORTANCE` of the category itself — essential | discretionary | optional. */
  importance: string;
  /**
   * §CAT-PAGE — which SIDE of the ledger this category lives on, and whether it is a leaf.
   *
   * Both change what the page means. An income bucket has no spending, no envelope and no
   * canonical monthly level; a sub-category does not roll other categories up into it. Sent
   * explicitly rather than inferred from `children.length` — a parent with no children yet is
   * still a parent, and guessing would make the page change shape when one is added.
   */
  is_income: boolean;
  is_sub: boolean;
  /** Sub-categories rolled INTO this one, so the page can say what it is aggregating. */
  children: { id: number; name: string; color: string | null }[];
  /**
   * What the category is MADE of in the selected window — each sub-category's share, plus the
   * parent's own directly-filed rows as a part of their own (`self`). Empty for a leaf.
   *
   * A parent's headline number is a roll-up, which is exactly what hides «Транспорт виріс — це
   * таксі чи пальне?». Shares are against the sum of the parts, so they add up to 100.
   */
  composition: { id: number; name: string; color: string | null; self: boolean; spent: number; n: number; share_pct: number }[];
  /**
   * §CAT-SUBS — how much of this category is a DECLARED subscription.
   *
   * A subscription is not the category «Підписки»: internet sits under utilities, cloud under
   * software. So the category total answers "how much" and hides "how much of it is fixed until I
   * cancel something", which is the question behind opening a category in the first place.
   * `share_pct` is against the canonical monthly level, and null wherever that level does not
   * exist (a sub-category, an income bucket) rather than a percentage of some other period.
   */
  subscriptions: {
    items: { id: number; title: string; monthly_base: number }[];
    monthly_base: number;
    share_pct: number | null;
  };
  /**
   * §CAT-PAGE — the whole history, independent of the selected window.
   *
   * Exists because the owner opened categories that were empty for the current month and read that
   * as "the app lost my spending". A lifetime line answers "is there anything here at all" before
   * the page answers "how much this month".
   */
  lifetime: {
    total: number; n: number;
    first_at: number | null; last_at: number | null;
    /** Months that actually had activity — the denominator of `per_active_month`. */
    active_months: number;
    /** Total ÷ ACTIVE months, never ÷ calendar span: a twice-a-year category would otherwise be
     *  reported with a monthly figure it has never once spent. */
    per_active_month: number;
  };
  /**
   * Who this category actually is, over the whole history rather than the window.
   * `share_pct` is against `lifetime.total`, so the rows are comparable to each other and to 100.
   */
  top_merchants: { merchant: string; spent: number; n: number; share_pct: number }[];
  /**
   * §categoryMonthlyLevels — the canonical "how much a month". NULL for a sub-category or an
   * income bucket: that canon is spend-only and rolls up, so there it would be a number about a
   * DIFFERENT category. `lifetime.per_active_month` carries the question instead.
   */
  level: { level: number; mean: number; last: number; active_months: number; fixed: boolean } | null;
  /** Twelve complete months, oldest first. Gaps are zeros, so the axis is continuous. */
  trend: { month: string; spent: number }[];
  /** §BUDGET-FORECAST — the envelope for this category, when one exists. */
  budget: {
    amount: number; base_amount: number; carried: number; rollover: boolean;
    spent: number; projected: number; lumpy: boolean;
  } | null;
  /**
   * §BUDGET-MEMORY — up to six CLOSED months, oldest first. `limit` is the effective limit that
   * month actually had (its own limit plus whatever it carried in), so the ratio is against what
   * was truly available at the time and not against today's setting. Empty until the first month
   * closes; months before the feature existed are deliberately never back-filled.
   */
  budget_history: { month: string; limit: number; spent: number }[];
  /** §E1 — spending that repeats versus spending that happened once, this period. */
  recurring: number;
  oneoff: number;
  /**
   * The SAME window one year earlier — seasonality.
   *
   * The 24-month trend above already contains these numbers, and that is precisely why this is
   * here: nobody can read «цей серпень проти торішнього» off a line with 24 points. A category
   * whose whole story is a yearly rhythm — insurance, tuition, holidays — looks like a random
   * spike in the trend and like a comparison in one figure.
   *
   * `null` when the window a year back predates the first transaction: comparing against a period
   * in which the account did not yet exist reports «+100%» about nothing.
   */
  year_ago: { spent: number; n: number } | null;
  /**
   * The average charge in this window, and in the window immediately before it.
   *
   * A separate question from the total, and the reason the page needed it: a category that grew
   * can have grown two ways, and they call for opposite reactions. More visits at the same price
   * is a habit; the same visits at a higher price is a price. The totals cannot tell them apart —
   * these two numbers can, and `n` is carried alongside so the reader can see which moved.
   *
   * `prev` is `null` when the previous window holds no charges — an average of nothing is not 0.
   */
  avg_check: { now: number; prev: number | null; n: number; prev_n: number } | null;
}

/**
 * §SHAPE — the shape of a period, not its size. Three blocks that survive being compared between
 * two months with identical totals.
 *
 * `up_to` is null for the open-ended top bucket; both bounds are in the reader's display currency
 * (§BASE-CUR), converted from round hryvnia steps so two months stay comparable.
 * `share_pct` is null where the window has no spending at all — 0% and "nothing happened" are
 * different statements, and a page that prints 0% over an empty month says the wrong one.
 */
export interface SpendingShape {
  spend: number;
  buckets: { from: number; up_to: number | null; n: number; spent: number; share_pct: number }[];
  unbudgeted: { spent: number; n: number; share_pct: number | null };
  uncategorised: { spent: number; n: number; share_pct: number | null };
}
