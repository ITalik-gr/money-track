import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { Account, Budget, Category, EventGroup, PlannedPayment, AiUsageStats, PlannedActual } from "../../shared/types.ts";

export interface EventWithAgg extends EventGroup {
  tx_count: number;
  spent: number;
  income: number;
}

export interface TxRow {
  id: string;
  account_id: string;
  source: string;
  time: number;
  amount: number;
  currency_code: number;
  original_amount?: number | null;
  original_currency?: number | null;
  mcc: number | null;
  category_id: number | null;
  merchant: string | null;
  comment: string | null;
  user_note: string | null;
  hold: number;
  category_name: string | null;
  category_color: string | null;
  category_icon?: string | null;
  account_title: string | null;
  is_transfer?: number;
  real_category_id?: number | null;   // реальна суть зняття/переказу → лишає операцію витратою
  transfer_pair_id?: string | null;   // пара-переказ між своїми: подача нейтральна (`lib/transfer.ts`)
  pair_account_title?: string | null; // рахунок другої сторони пари → маршрут «звідки → куди»
  planned_id?: number | null;   // прив'язано до підписки → бейдж «підписка» (§R6)
  event_id?: number | null;
  event_name?: string | null;
  event_color?: string | null;
  importance?: string | null;   // §6: override вагомості операції (essential|discretionary|optional)
}

export interface ReceiptItemRow { id: number; name: string | null; qty: number | null; price: number | null }
export interface ReceiptRow {
  id: number; image_key: string | null; store: string | null; total: number | null;
  currency_code: number | null; purchased_at: number | null; items: ReceiptItemRow[];
}
export interface TagRow { id: number; name: string; color: string | null }
export interface TxDetail extends TxRow {
  mcc: number | null;
  real_category_id: number | null;      // реальна категорія переказу/зняття (§F2 крок 2)
  real_category_name: string | null;
  real_category_color: string | null;
  cashback: number | null;
  comment: string | null;
  balance_after: number | null;
  receipt_id: number | null;
  raw_json: string | null;
  category_icon: string | null;
  account_type: string | null;
  is_transfer?: number;
  ai_enriched?: number;
  name_locked?: number;             // §R7: ручну назву зафіксовано — AI не перезаписує
  ai_note?: string | null;          // розуміння AI «що це» (§R5)
  planned_id?: number | null;       // зв'язок із підпискою
  planned_title?: string | null;    // назва підписки, якщо прив'язано
  event_id?: number | null;
  event_name?: string | null;
  receipt: ReceiptRow | null;
  tags: TagRow[];
}

export interface AiFact {
  label: string;
  amount?: number | null;    // грн (major)
  category?: string | null;
  delta_pct?: number | null;
  tone?: "pos" | "neg" | "neutral" | null;
}
export interface AdviceAction {
  type: "create_budget";
  label: string;
  category_id?: number | null;
  category_name?: string | null;
  amount_uah?: number | null;
}
export interface AiUsageBrief { in: number; out: number; cache_read: number }

export interface Advice {
  runway_comment: string;
  summary: string;
  facts?: AiFact[];
  suggestions: { title: string; detail: string; action?: AdviceAction | null }[];
  own_funds: number;
  cushion: number;
  debt: number;
  investment?: number;
  monthly_burn: number;
  runway_months: number | null;
  usage?: AiUsageBrief;
  generated_at: number;
}
export interface AdviceHistoryItem {
  generated_at: number; summary: string; runway_months: number | null; monthly_burn: number; own_funds: number;
  cushion?: number;
}

export interface Summary {
  byCurrency: { currency_code: number; own: number }[];
  totalUAH: number;
  credit: { accountId: string; limit: number; own: number; debt: number } | null;
}

export interface SafeToSpend {
  safe: number; income: number; spend: number; essential: number; discretionary: number;
  subs_monthly: number; subs_remaining: number; month_start: number;
}
export interface CapitalTrend {
  now_uah: number;
  points: { t: number; capital_uah: number }[];
}
export interface CategorySpend {
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  spent: number; // канонічно, зведено в ₴ (додатнє)
  n: number;
}

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

export interface Overview {
  summary: { spend: number; income: number; n: number };
  prev: { spend: number; income: number; n: number };
  range: { from: number; to: number; prevFrom: number; prevTo: number; bucket: string; mode: "calendar" | "rolling"; preset: string | null };
  series: { bucket: string; spend: number; income: number }[];
  byCategory: { category_id: number | null; category_name: string | null; color: string | null; spent: number; n: number }[];
  byMerchant: { merchant: string; spent: number; n: number }[];
  byAccount: { account_id: string | null; account_title: string | null; account_type: string | null; spent: number; n: number }[];
  byEvent: { event_id: number; event_name: string; event_color: string | null; spent: number; n: number }[];
  byImportance: { importance: string; spent: number; n: number }[];
}
export type PeriodMode = "calendar" | "rolling";
export type AiTask = "report" | "advisor" | "insight" | "chat" | "budget" | "group";
export type AiModelToken = "haiku" | "sonnet" | "opus";
export type Preset = "week" | "month" | "quarter" | "year";

export interface CompareBucket {
  from: number; to: number; spend: number; income: number;
  byCategory: { category_id: number | null; category_name: string | null; color: string | null; spent: number }[];
}
export interface Compare { a: CompareBucket; b: CompareBucket }

export interface StructuredInsight {
  headline: string;
  facts: AiFact[];
  note?: string | null;
}
export interface Insight {
  text: string;
  structured?: StructuredInsight;
  usage?: AiUsageBrief;
  generated_at: number;
  period_from: number;
  period_to: number;
  period_days: number;
  empty?: boolean;
}

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

export interface DrillTx { id: string; time: number; amount: number; currency_code: number; merchant: string | null; comment: string | null; user_note?: string | null; category_name?: string | null; category_color?: string | null }
export interface CategoryDrill {
  subs: { category_id: number | null; name: string; color: string | null; spent: number; n: number }[];
  merchants: { merchant: string; spent: number; n: number }[];
  transactions: DrillTx[];
}
export interface SliceDrill { spent: number; n: number; transactions: DrillTx[] }

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
  transactions: TxRow[];
}

// §Аналітика 2.0 — AI-репорти.
export interface FinancialReport {
  headline: string;
  summary: string;
  sections: { title: string; body: string }[];
  category_breakdown: { name: string; amount_uah: number; delta_pct: number | null; note: string | null }[];
  anomalies: { label: string; detail: string; severity: "info" | "warn" | "high" }[];
  predictions: { next_period_spend_uah: number | null; runway_months: number | null; note: string | null };
  advice: { title: string; detail: string; action?: AdviceAction | null }[];
  trend?: { month: string; spend_uah: number; income_uah: number }[]; // §5: детерміновані дані для лінії
  importance?: { level: string; amount_uah: number; pct: number }[]; // §6: детермінована розбивка вагомості
  // §R6: детерміновані категорії (надійні суми + дельта + prev) з приклеєною AI-нотаткою.
  categories?: { name: string; amount_uah: number; prev_uah: number; delta_pct: number | null; note?: string | null }[];
}
export interface ReportListItem {
  id: number; period_type: "week" | "month"; period_from: number; period_to: number;
  created_at: number; model: string | null; cost_usd: number | null; summary: string | null;
}
export interface ReportFull extends ReportListItem { data: FinancialReport }
export interface TransferReviewRow {
  id: string; merchant: string | null; comment: string | null; amount: number; currency_code: number; time: number;
  real_category_id: number | null; note: string | null; needs_attention: boolean;
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
  current: number; // ефективний прогрес (баланс банки або ручний)
}

export interface Forecast {
  monthStart: number; now: number; daysInMonth: number; daysElapsed: number; daysRemaining: number;
  spend: number; income: number; pace: number;
  projectedSpend: number; projectedNet: number;
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

export interface UpcomingSubs {
  days: number; total: number;
  items: { id: number; title: string; amount: number; at: number; days_until: number }[];
}

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
export interface PaceItem {
  category: string; color: string | null; spent: number;
  oneoff: number; mostly_oneoff: boolean; lumpy: boolean;
  projected: number; usual: number; pct: number | null;
}

export interface SetupStatus {
  webhookRegistered: boolean;
  accounts: number;
  transactions: number;
  backfill: { progress: number; total: number; done: boolean } | null;
}

// §A1: факт про світ. adjust_* рухає числа лише коли confirmed_at != null (гейт підтвердження).
export interface Fact {
  id: number; text: string; effective_from: number; expires_at: number | null;
  category_id: number | null; category_name: string | null;
  adjust_kind: "multiplier" | "delta_minor" | null; adjust_value: number | null;
  confirmed_at: number | null; source: string; created_at: number;
}
export interface FactInput {
  text: string; effective_from?: number; expires_at?: number | null;
  category_id?: number | null; adjust_kind?: "multiplier" | "delta_minor" | null;
  adjust_value?: number | null; confirm?: boolean;
}
// §A5: метадані вбудованого документа корпусу знань (для картки на рейлі Порадника).
export interface KnowledgeMeta { id: string; title: string; summary: string; chars: number }
// §H: детермінований Індекс фінздоров'я (без AI) — 4 складові + зважений скор 0..100.
export interface HealthComponent { key: string; label: string; value: string; score: number; hint: string }
export interface FinanceHealth { score: number; band: "good" | "ok" | "risk"; components: HealthComponent[] }

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Tx", "Account", "Summary", "Budget", "Planned", "Setup", "Me", "Insight", "Profile", "Advice", "Event", "Category", "Goal", "Report", "Fact"],
  endpoints: (b) => ({
    getMe: b.query<{ authenticated: boolean }, void>({ query: () => "/me", providesTags: ["Me"] }),
    login: b.mutation<{ ok: boolean }, string>({
      query: (password) => ({ url: "/login", method: "POST", body: { password } }),
      invalidatesTags: ["Me", "Tx", "Account", "Summary", "Setup"],
    }),
    logout: b.mutation<unknown, void>({
      query: () => ({ url: "/logout", method: "POST" }),
      invalidatesTags: ["Me"],
    }),
    getSummary: b.query<Summary, void>({ query: () => "/summary", providesTags: ["Summary"] }),
    getAccounts: b.query<Account[], void>({ query: () => "/accounts", providesTags: ["Account"] }),
    addManualAccount: b.mutation<{ ok: boolean; id: string }, { type: "manual_card" | "crypto"; title: string; currency_code: number; balance: number }>({
      query: (body) => ({ url: "/accounts/manual", method: "POST", body }),
      invalidatesTags: ["Account", "Summary"],
    }),
    editManualAccount: b.mutation<unknown, { id: string; balance?: number; title?: string }>({
      query: ({ id, ...body }) => ({ url: `/accounts/manual/${id}`, method: "PATCH", body }),
      invalidatesTags: ["Account", "Summary"],
    }),
    setAccountTitle: b.mutation<unknown, { id: string; title: string }>({
      query: ({ id, title }) => ({ url: `/accounts/${id}/title`, method: "PATCH", body: { title } }),
      invalidatesTags: ["Account"],
    }),
    // §R3: роль рахунку (ліквідний/інвестиційний) + опис для AI.
    setAccountMeta: b.mutation<unknown, { id: string; role?: "liquid" | "investment"; ai_note?: string }>({
      query: ({ id, ...body }) => ({ url: `/accounts/${id}/meta`, method: "PATCH", body }),
      invalidatesTags: ["Account", "Summary"],
    }),
    getRates: b.query<{ rates: Record<string, number>; updated: number | null }, void>({
      query: () => "/rates", providesTags: ["Summary"],
    }),
    getCategories: b.query<Category[], void>({ query: () => "/categories", providesTags: ["Category"] }),
    createCategory: b.mutation<{ ok: boolean; id: number }, { name: string; color?: string; icon?: string; parent_id?: number | null; is_income?: boolean; importance?: string | null }>({
      query: (body) => ({ url: "/categories", method: "POST", body }),
      invalidatesTags: ["Category"],
    }),
    updateCategory: b.mutation<{ ok: boolean }, { id: number; name?: string; color?: string; icon?: string; parent_id?: number | null; importance?: string | null }>({
      query: ({ id, ...body }) => ({ url: `/categories/${id}`, method: "PATCH", body }),
      invalidatesTags: ["Category", "Tx"],
    }),
    getCategoryUsage: b.query<{ transactions: number; tags: number; subcategories: number }, number>({
      query: (id) => `/categories/${id}/usage`,
    }),
    deleteCategory: b.mutation<unknown, { id: number; reassign?: number | null }>({
      query: ({ id, reassign }) => ({ url: `/categories/${id}?reassign=${reassign ?? "none"}`, method: "DELETE" }),
      invalidatesTags: ["Category", "Tx", "Summary"],
    }),
    getEvents: b.query<EventWithAgg[], void>({ query: () => "/events", providesTags: ["Event"] }),
    getEvent: b.query<{ event: EventGroup; transactions: TxRow[] }, number>({
      query: (id) => `/events/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Event", id }],
    }),
    createEvent: b.mutation<{ ok: boolean; id: number }, { name: string; kind?: string; color?: string; icon?: string; note?: string }>({
      query: (body) => ({ url: "/events", method: "POST", body }),
      invalidatesTags: ["Event"],
    }),
    deleteEvent: b.mutation<unknown, number>({
      query: (id) => ({ url: `/events/${id}`, method: "DELETE" }),
      invalidatesTags: ["Event", "Tx"],
    }),
    getBudgets: b.query<Budget[], void>({ query: () => "/budgets", providesTags: ["Budget"] }),
    getPlanned: b.query<PlannedPayment[], void>({ query: () => "/planned", providesTags: ["Planned"] }),
    // §Хвіст C: глобальний лічильник витрат AI (сьогодні/місяць/за весь час).
    getAiUsage: b.query<AiUsageStats, void>({ query: () => "/ai-usage", providesTags: ["Tx"] }),
    // §Хвіст: факт vs план по підписках.
    getPlannedActuals: b.query<PlannedActual[], void>({ query: () => "/planned/actuals", providesTags: ["Planned", "Tx"] }),
    // §Аналітика 2.0 — AI-репорти.
    getReports: b.query<ReportListItem[], { type?: "week" | "month" } | void>({
      query: (arg) => `/reports${arg && arg.type ? `?type=${arg.type}` : ""}`,
      providesTags: ["Report"],
    }),
    getReport: b.query<ReportFull, number>({
      query: (id) => `/reports/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Report", id }],
    }),
    generateReport: b.mutation<{ ok: boolean; id: number; created: boolean }, { type: "week" | "month"; force?: boolean; scope?: "current" | "last" }>({
      query: (body) => ({ url: "/reports/generate", method: "POST", body }),
      invalidatesTags: ["Report"],
    }),
    deleteReport: b.mutation<{ ok: boolean }, number>({
      query: (id) => ({ url: `/reports/${id}`, method: "DELETE" }),
      invalidatesTags: ["Report"],
    }),
    getTransaction: b.query<TxDetail, string>({
      query: (id) => `/transactions/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Tx", id }],
    }),
    getTransactions: b.query<TxRow[], { limit?: number; category?: number; catparent?: number; type?: string; account?: string; q?: string; from?: number; to?: number; amin?: number; amax?: number }>({
      query: (p) => {
        const s = new URLSearchParams();
        if (p.limit) s.set("limit", String(p.limit));
        if (p.category) s.set("category", String(p.category));
        if (p.catparent) s.set("catparent", String(p.catparent));
        if (p.type) s.set("type", p.type);
        if (p.account) s.set("account", p.account);
        if (p.q) s.set("q", p.q);
        if (p.from) s.set("from", String(p.from));
        if (p.to) s.set("to", String(p.to));
        if (p.amin != null) s.set("amin", String(p.amin));
        if (p.amax != null) s.set("amax", String(p.amax));
        return `/transactions?${s.toString()}`;
      },
      providesTags: ["Tx"],
    }),
    getByCategory: b.query<CategorySpend[], { from: number; to: number }>({
      query: ({ from, to }) => `/analytics/by-category?from=${from}&to=${to}`,
    }),
    getSafeToSpend: b.query<SafeToSpend, void>({ query: () => "/analytics/safe-to-spend", providesTags: ["Tx", "Summary", "Budget"] }),
    getCapitalTrend: b.query<CapitalTrend, number | void>({ query: (months) => `/analytics/capital-trend?months=${months ?? 6}`, providesTags: ["Tx", "Summary"] }),
    // currency undefined → зведено в ₴; preset → сервер рахує межі за period_mode.
    getMerchant: b.query<MerchantAnalytics, string>({
      query: (name) => `/analytics/merchant?name=${encodeURIComponent(name)}`,
      providesTags: ["Summary"],
    }),
    getOverview: b.query<Overview, { preset?: Preset; from?: number; to?: number; bucket?: string; currency?: number | null }>({
      query: ({ preset, from, to, bucket, currency }) => {
        const p = new URLSearchParams();
        if (preset) p.set("preset", preset);
        if (from != null) p.set("from", String(from));
        if (to != null) p.set("to", String(to));
        if (bucket) p.set("bucket", bucket);
        if (currency) p.set("currency", String(currency));
        return `/analytics/overview?${p.toString()}`;
      },
      providesTags: ["Tx"],
    }),
    getPeriodMode: b.query<{ mode: PeriodMode }, void>({ query: () => "/settings/period-mode", providesTags: ["Setup"] }),
    setPeriodMode: b.mutation<{ ok: boolean; mode: PeriodMode }, PeriodMode>({
      query: (mode) => ({ url: "/settings/period-mode", method: "PUT", body: { mode } }),
      invalidatesTags: ["Setup", "Tx"],
    }),
    getAiModels: b.query<{ models: Record<AiTask, AiModelToken> }, void>({ query: () => "/settings/ai-models", providesTags: ["Setup"] }),
    setAiModel: b.mutation<{ ok: boolean; task: AiTask; model: AiModelToken }, { task: AiTask; model: AiModelToken }>({
      query: (body) => ({ url: "/settings/ai-models", method: "PUT", body }),
      invalidatesTags: ["Setup"],
    }),
    getCurrencies: b.query<number[], void>({ query: () => "/analytics/currencies" }),
    getForecast: b.query<Forecast, void>({ query: () => "/analytics/forecast", providesTags: ["Tx"] }),
    getIncomeAnalytics: b.query<IncomeAnalytics, { preset?: string; currency?: number | null }>({
      query: ({ preset, currency }) => `/analytics/income?preset=${preset ?? "month"}${currency ? `&currency=${currency}` : ""}`,
      providesTags: ["Tx"],
    }),
    getUpcomingSubs: b.query<UpcomingSubs, number | void>({ query: (days) => `/planned/upcoming?days=${days ?? 30}`, providesTags: ["Tx", "Planned"] }),
    getReceiptItems: b.query<ReceiptItemsAnalytics, { from: number; to: number; limit?: number }>({
      query: ({ from, to, limit }) => `/analytics/receipt-items?from=${from}&to=${to}${limit ? `&limit=${limit}` : ""}`,
      providesTags: ["Tx"],
    }),
    getPatterns: b.query<SpendPatterns, void>({ query: () => "/analytics/patterns", providesTags: ["Tx"] }),
    getPriceDrift: b.query<PriceDrift, void>({ query: () => "/analytics/price-drift", providesTags: ["Tx"] }),
    getCompare: b.query<Compare, { from: number; to: number; currency?: number | null; bfrom?: number; bto?: number }>({
      query: ({ from, to, currency, bfrom, bto }) =>
        `/analytics/compare?from=${from}&to=${to}${currency ? `&currency=${currency}` : ""}` +
        (bfrom != null && bto != null ? `&bfrom=${bfrom}&bto=${bto}` : ``),
      providesTags: ["Tx"],
    }),
    getCategoryDrill: b.query<CategoryDrill, { category: number; from: number; to: number; currency?: number | null }>({
      query: ({ category, from, to, currency }) => `/analytics/category?category=${category}&from=${from}&to=${to}${currency ? `&currency=${currency}` : ""}`,
      providesTags: ["Tx"],
    }),
    getSliceDrill: b.query<SliceDrill, { dim: "merchant" | "account" | "event" | "weekday" | "day" | "dom" | "importance" | "all"; value?: string; type?: "expense" | "income"; from: number; to: number; currency?: number | null; limit?: number }>({
      query: ({ dim, value, type, from, to, currency, limit }) => {
        const p = new URLSearchParams({ dim, from: String(from), to: String(to) });
        if (value != null) p.set("value", value);
        if (type) p.set("type", type);
        if (currency) p.set("currency", String(currency));
        if (limit) p.set("limit", String(limit));
        return `/analytics/slice?${p.toString()}`;
      },
      providesTags: ["Tx"],
    }),
    getGoals: b.query<SavingsGoal[], void>({ query: () => "/goals", providesTags: ["Goal"] }),
    createGoal: b.mutation<{ ok: boolean; id: number }, { name: string; target_amount: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string }>({
      query: (body) => ({ url: "/goals", method: "POST", body }),
      invalidatesTags: ["Goal"],
    }),
    updateGoal: b.mutation<{ ok: boolean }, { id: number; name?: string; target_amount?: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string }>({
      query: ({ id, ...body }) => ({ url: `/goals/${id}`, method: "PATCH", body }),
      invalidatesTags: ["Goal"],
    }),
    deleteGoal: b.mutation<unknown, number>({
      query: (id) => ({ url: `/goals/${id}`, method: "DELETE" }),
      invalidatesTags: ["Goal"],
    }),
    addTransaction: b.mutation<{ ok: boolean; id: string }, Record<string, unknown>>({
      query: (body) => ({ url: "/transactions", method: "POST", body }),
      invalidatesTags: ["Tx", "Summary"],
    }),
    editTransaction: b.mutation<unknown, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `/transactions/${id}`, method: "PATCH", body }),
      invalidatesTags: (_r, _e, { id }) => ["Tx", { type: "Tx", id }, "Summary", "Event"],
    }),
    bulkEditTransactions: b.mutation<{ ok: boolean; updated: number }, { ids: string[]; event_id?: number | null; category_id?: number | null; is_transfer?: boolean }>({
      query: (body) => ({ url: "/transactions/bulk", method: "POST", body }),
      invalidatesTags: ["Tx", "Summary", "Event"],
    }),
    setBudget: b.mutation<unknown, { category_id: number; period: string; amount: number; rollover?: boolean }>({
      query: (body) => ({ url: "/budgets", method: "PUT", body }),
      invalidatesTags: ["Budget"],
    }),
    budgetChat: b.mutation<BudgetChatReply, { messages: { role: "user" | "assistant"; content: string }[] }>({
      query: (body) => ({ url: "/budgets/chat", method: "POST", body }),
    }),
    proposeBudgets: b.mutation<BudgetPlanResult, void>({
      query: () => ({ url: "/budgets/propose", method: "POST" }),
    }),
    addPlanned: b.mutation<unknown, Record<string, unknown>>({
      query: (body) => ({ url: "/planned", method: "POST", body }),
      invalidatesTags: ["Planned"],
    }),
    deletePlanned: b.mutation<unknown, number>({
      query: (id) => ({ url: `/planned/${id}`, method: "DELETE" }),
      invalidatesTags: ["Planned"],
    }),
    updatePlanned: b.mutation<unknown, { id: number; note?: string | null; category_id?: number | null }>({
      query: ({ id, ...body }) => ({ url: `/planned/${id}`, method: "PATCH", body }),
      invalidatesTags: ["Planned"],
    }),
    dismissPlannedCandidate: b.mutation<{ ok: boolean }, string>({
      query: (merchant) => ({ url: "/planned/dismiss", method: "POST", body: { merchant } }),
      invalidatesTags: ["Planned"],
    }),
    detectPlanned: b.query<RecurringCandidate[], void>({
      query: () => "/planned/detect",
      providesTags: ["Planned"],
    }),
    applySubscriptionCategories: b.mutation<{ fixed: number }, void>({
      query: () => ({ url: "/planned/apply-categories", method: "POST" }),
      invalidatesTags: ["Tx", "Planned"],
    }),
    aiDetectPlanned: b.mutation<{ query?: string; candidates: { title: string; period_amount: number; currency_code: number; n: number; avg_interval_days: number; last_time?: number; category_id?: number | null }[]; error?: string }, string>({
      query: (description) => ({ url: "/planned/ai-detect", method: "POST", body: { description } }),
    }),
    // setup
    getSetupStatus: b.query<SetupStatus, void>({ query: () => "/setup/status", providesTags: ["Setup"] }),
    syncAccounts: b.mutation<unknown, void>({
      query: () => ({ url: "/setup/sync-accounts", method: "POST" }),
      invalidatesTags: ["Setup", "Account", "Summary"],
    }),
    registerWebhook: b.mutation<unknown, void>({
      query: () => ({ url: "/setup/register-webhook", method: "POST" }),
      invalidatesTags: ["Setup"],
    }),
    registerTelegram: b.mutation<{ ok?: boolean; url?: string; error?: string }, void>({
      query: () => ({ url: "/setup/register-telegram", method: "POST" }),
    }),
    tgProactive: b.mutation<{ sent: boolean; reason?: string }, void>({
      query: () => ({ url: "/tg/proactive", method: "POST" }),
    }),
    scanAlerts: b.mutation<{ sent: number }, void>({
      query: () => ({ url: "/alerts/scan", method: "POST" }),
      invalidatesTags: ["Tx"],
    }),
    backfillStart: b.mutation<{ total: number }, void>({
      query: () => ({ url: "/setup/backfill/start", method: "POST" }),
    }),
    backfillStep: b.mutation<{ done: boolean; progress: number; total: number; retry?: boolean }, void>({
      query: () => ({ url: "/setup/backfill/step", method: "POST" }),
      invalidatesTags: ["Tx", "Setup"],
    }),
    refreshRates: b.mutation<unknown, void>({
      query: () => ({ url: "/rates/refresh", method: "POST" }),
      invalidatesTags: ["Summary"],
    }),
    detectTransfers: b.mutation<{ marked: number }, void>({
      query: () => ({ url: "/transfers/detect", method: "POST" }),
      invalidatesTags: ["Tx"],
    }),
    // §F2 крок 2: AI-розмітка реальної категорії переказів/знять (батч, клієнт лупить).
    categorizeTransfers: b.mutation<{ categorized: number; remaining: number }, void>({
      query: () => ({ url: "/transfers/categorize", method: "POST" }),
      invalidatesTags: ["Tx"],
    }),
    getTransfersStatus: b.query<{ pending: number }, void>({ query: () => "/transfers/status", providesTags: ["Tx"] }),
    reviewTransfers: b.mutation<{ rows: TransferReviewRow[]; remaining: number }, number | void>({
      query: (limit) => ({ url: `/transfers/review${limit ? `?limit=${limit}` : ""}`, method: "POST" }),
      // не інвалідуємо Tx одразу — модалка сама покаже рядки; збереження оновить.
    }),
    saveTransferReview: b.mutation<{ ok: boolean; saved: number }, { items: { id: string; real_category_id: number | null; learn?: boolean }[] }>({
      query: (body) => ({ url: "/transfers/review/save", method: "POST", body }),
      invalidatesTags: ["Tx"],
    }),
    // §C2: перепрогнати один переказ через AI з підказкою користувача.
    reviewTransferOne: b.mutation<TransferReviewRow, { id: string; hint: string }>({
      query: (body) => ({ url: "/transfers/review/one", method: "POST", body }),
    }),
    getInsight: b.query<Insight | null, void>({ query: () => "/insight", providesTags: ["Insight"] }),
    generateInsight: b.mutation<Insight, number | void>({
      query: (days) => ({ url: `/insight/generate${days ? `?days=${days}` : ""}`, method: "POST" }),
      invalidatesTags: ["Insight"],
    }),
    // AI enrichment
    enrichTransaction: b.mutation<unknown, string>({
      query: (id) => ({ url: `/transactions/${id}/enrich`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => ["Tx", { type: "Tx", id }],
    }),
    enrichPending: b.mutation<{ enriched: number; remaining: number }, void>({
      query: () => ({ url: "/enrich/pending", method: "POST" }),
      invalidatesTags: ["Tx"],
    }),
    getEnrichStatus: b.query<{ pending: number }, void>({ query: () => "/enrich/status", providesTags: ["Tx"] }),
    // advisor + profile
    getProfile: b.query<{ text: string }, void>({ query: () => "/profile", providesTags: ["Profile"] }),
    setProfile: b.mutation<unknown, string>({
      query: (text) => ({ url: "/profile", method: "PUT", body: { text } }),
      invalidatesTags: ["Profile"],
    }),
    getAdvice: b.query<Advice | null, void>({ query: () => "/advisor", providesTags: ["Advice"] }),
    getAdviceHistory: b.query<AdviceHistoryItem[], void>({ query: () => "/advisor/history", providesTags: ["Advice"] }),
    generateAdvice: b.mutation<Advice, void>({
      query: () => ({ url: "/advisor/generate", method: "POST" }),
      invalidatesTags: ["Advice"],
    }),
    clearAdviceHistory: b.mutation<{ ok: boolean }, void>({
      query: () => ({ url: "/advisor/history", method: "DELETE" }),
      invalidatesTags: ["Advice"],
    }),
    chatAdvice: b.mutation<{ reply: string }, { messages: { role: "user" | "assistant"; content: string }[]; attachedTxIds?: string[] }>({
      query: (body) => ({ url: "/advisor/chat", method: "POST", body }),
    }),
    evaluateGroup: b.mutation<StructuredInsight, number>({
      query: (id) => ({ url: `/events/${id}/ai`, method: "POST" }),
    }),
    chatGroup: b.mutation<{ reply: string }, { id: number; messages: { role: "user" | "assistant"; content: string }[] }>({
      query: ({ id, messages }) => ({ url: `/events/${id}/chat`, method: "POST", body: { messages } }),
    }),
    chatTx: b.mutation<
      { reply: string; applied?: { category_id?: number | null; category_name?: string | null; is_transfer?: boolean; understanding?: string } },
      { id: string; messages: { role: "user" | "assistant"; content: string }[] }
    >({
      query: ({ id, messages }) => ({ url: `/transactions/${id}/chat`, method: "POST", body: { messages } }),
      // Оновлення категорії/переказу застосовується на бекенді — перечитуємо транзакцію.
      invalidatesTags: (_r, _e, { id }) => ["Tx", { type: "Tx", id }, "Summary"],
    }),
    // §A1: шар фактів. Підтвердження/видалення факту з коригуванням рухає burn/runway →
    // інвалідуємо Tx/Summary/Advice, щоб цифри всюди перерахувались.
    getFacts: b.query<Fact[], void>({ query: () => "/facts", providesTags: ["Fact"] }),
    // §A5: метадані вбудованого корпусу знань (статичне; сам текст живе в промті чату).
    getKnowledge: b.query<KnowledgeMeta[], void>({ query: () => "/knowledge" }),
    // §H: детермінований Індекс фінздоров'я. Провайдить Advice → перерахунок при зміні фактів/порад.
    getHealth: b.query<FinanceHealth, void>({ query: () => "/analytics/health", providesTags: ["Advice"] }),
    addFact: b.mutation<{ id: number | null }, FactInput>({
      query: (body) => ({ url: "/facts", method: "POST", body }),
      invalidatesTags: ["Fact", "Tx", "Summary", "Advice"],
    }),
    confirmFact: b.mutation<{ ok: boolean }, { id: number; on: boolean }>({
      query: ({ id, on }) => ({ url: `/facts/${id}/confirm`, method: "POST", body: { on } }),
      invalidatesTags: ["Fact", "Tx", "Summary", "Advice"],
    }),
    deleteFact: b.mutation<{ ok: boolean }, number>({
      query: (id) => ({ url: `/facts/${id}`, method: "DELETE" }),
      invalidatesTags: ["Fact", "Tx", "Summary", "Advice"],
    }),
  }),
});

export const {
  useGetMeQuery,
  useLoginMutation,
  useLogoutMutation,
  useGetSummaryQuery,
  useGetAccountsQuery,
  useAddManualAccountMutation,
  useEditManualAccountMutation,
  useSetAccountTitleMutation,
  useSetAccountMetaMutation,
  useGetRatesQuery,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  useLazyGetCategoryUsageQuery,
  useGetEventsQuery,
  useGetEventQuery,
  useCreateEventMutation,
  useDeleteEventMutation,
  useGetBudgetsQuery,
  useGetPlannedQuery,
  useGetAiUsageQuery,
  useGetPlannedActualsQuery,
  useGetPeriodModeQuery,
  useSetPeriodModeMutation,
  useGetAiModelsQuery,
  useSetAiModelMutation,
  useGetReportsQuery,
  useGetReportQuery,
  useGenerateReportMutation,
  useDeleteReportMutation,
  useGetTransactionsQuery,
  useGetTransactionQuery,
  useGetByCategoryQuery,
  useGetSafeToSpendQuery,
  useGetCapitalTrendQuery,
  useGetMerchantQuery,
  useGetOverviewQuery,
  useGetCurrenciesQuery,
  useGetForecastQuery,
  useGetIncomeAnalyticsQuery,
  useGetUpcomingSubsQuery,
  useGetReceiptItemsQuery,
  useGetPatternsQuery,
  useGetPriceDriftQuery,
  useGetCompareQuery,
  useGetCategoryDrillQuery,
  useGetSliceDrillQuery,
  useGetGoalsQuery,
  useCreateGoalMutation,
  useUpdateGoalMutation,
  useDeleteGoalMutation,
  useAddTransactionMutation,
  useEditTransactionMutation,
  useBulkEditTransactionsMutation,
  useSetBudgetMutation,
  useProposeBudgetsMutation,
  useBudgetChatMutation,
  useAddPlannedMutation,
  useDeletePlannedMutation,
  useDetectPlannedQuery,
  useAiDetectPlannedMutation,
  useGetSetupStatusQuery,
  useSyncAccountsMutation,
  useRegisterWebhookMutation,
  useRegisterTelegramMutation,
  useTgProactiveMutation,
  useScanAlertsMutation,
  useBackfillStartMutation,
  useBackfillStepMutation,
  useRefreshRatesMutation,
  useDetectTransfersMutation,
  useApplySubscriptionCategoriesMutation,
  useUpdatePlannedMutation,
  useDismissPlannedCandidateMutation,
  useCategorizeTransfersMutation,
  useReviewTransfersMutation,
  useSaveTransferReviewMutation,
  useReviewTransferOneMutation,
  useGetTransfersStatusQuery,
  useGetInsightQuery,
  useGenerateInsightMutation,
  useEnrichTransactionMutation,
  useEnrichPendingMutation,
  useGetEnrichStatusQuery,
  useGetProfileQuery,
  useSetProfileMutation,
  useGetAdviceQuery,
  useGetAdviceHistoryQuery,
  useGenerateAdviceMutation,
  useClearAdviceHistoryMutation,
  useChatAdviceMutation,
  useEvaluateGroupMutation,
  useChatGroupMutation,
  useChatTxMutation,
  useGetFactsQuery,
  useGetKnowledgeQuery,
  useGetHealthQuery,
  useAddFactMutation,
  useConfirmFactMutation,
  useDeleteFactMutation,
} = api;
