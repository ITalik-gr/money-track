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

export interface Overview {
  summary: PeriodTotals;
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
export interface MonthlyHistory { months: { month: string; spend: number; income: number; essential: number; discretionary: number; optional: number }[] }

export interface SafeToSpend {
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

export interface CompareBucket {
  from: number; to: number; spend: number; income: number;
  byCategory: { category_id: number | null; category_name: string | null; color: string | null; spent: number }[];
}
export interface Compare { a: CompareBucket; b: CompareBucket }

export interface Forecast {
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
  /** Sub-categories rolled INTO this one, so the page can say what it is aggregating. */
  children: { id: number; name: string; color: string | null }[];
  /** §categoryMonthlyLevels — the canonical "how much a month", and how it was decided. */
  level: { level: number; mean: number; last: number; active_months: number; fixed: boolean } | null;
  /** Twelve complete months, oldest first. Gaps are zeros, so the axis is continuous. */
  trend: { month: string; spent: number }[];
  /** §BUDGET-FORECAST — the envelope for this category, when one exists. */
  budget: { amount: number; spent: number; projected: number; lumpy: boolean } | null;
  /** §E1 — spending that repeats versus spending that happened once, this period. */
  recurring: number;
  oneoff: number;
}
