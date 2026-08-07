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
 * ⚠️ `n` is `null`, not `0`, when NO transaction row matched at all — an empty account, or a
 * period before the first import. `spendSum`/`incomeSum` wrap themselves in `COALESCE(…, 0)`;
 * `SPEND_COUNT` does not, and SQL `SUM()` over an empty set is NULL. The contract says so
 * because that is what goes over the wire (recorded in `__golden__/empty/`), not because it is
 * desirable — the fix belongs on the server and has its own card in ROADMAP.md.
 */
export interface PeriodTotals { spend: number; income: number; n: number | null }

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

export interface MonthlyHistory { months: { month: string; spend: number; income: number }[] }

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
