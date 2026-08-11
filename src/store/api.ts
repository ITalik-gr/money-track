import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { Account, Budget, Category, EventGroup, PlannedPayment, AiUsageStats, PlannedActual } from "../../shared/types.ts";
import { getLocale } from "../i18n/locale.ts";

// The API contract lives in `shared/api/` and is imported, not re-declared (phase 2, defect D2).
// It is RE-EXPORTED from here because 66 files already import these names from `store/api.ts`;
// pointing every one of them at `shared/` would be a large diff that proves nothing. What matters
// is that this file no longer DECLARES a response shape — the worker annotates its returns with
// the same types, so `tsc` is what notices drift now, instead of a user noticing it in production.
export type * from "../../shared/api/index.ts";
import type {
  Advice, AdviceHistoryItem, AiJob, AiModelToken, AiTask, AutoBudget, BudgetChatReply,
  BudgetPlanResult, CapitalTrend, CashflowCalendar, CategoryDrill, CategorySpend, Compare,
  CredentialStatus, CurrenciesList, EventWithAgg, AiJobKind, Preset, ReportPeriodType, StructuredInsight, Fact, FactInput, FinanceHealth, Forecast,
  FrequentTx, FundsBreakdown, GoalBody, GoalContribution, IncomeAnalytics, Insight,
  KnowledgeDocFull, KnowledgeList, MerchantAnalytics, MonthlyHistory, Networth,
  NotifPrefs, NotificationFeed, Overview, PeriodMode, PriceDrift, ReceiptItemsAnalytics,
  RecurringCandidate, Reimbursement, ReimbursementUsage, ReportFull, ReportListItem, SafeToSpend,
  SavedFilter, SavingsGoal, SearchResults, SetupStatus, SliceDrill, SparkData, SpendPatterns,
  Summary, TransferReviewRow, TranslitFix, TxDetail, TxRow, TxSplit, UpcomingSubs, AdminUser, WeekdayAnalytics,
  AccountHistory, Habits, ChatSummary, ChatDetail, AdminFeedback, FeedbackContact, FeedbackKind,
  BackupList, RestoreResult, PushStatus, PushSendResult,
} from "../../shared/api/index.ts";

export const api = createApi({
  reducerPath: "api",
  // Кожен запит несе МОВУ, якою людина зараз дивиться на застосунок.
  //
  // Доти сервер брав її лише з `app_state.locale`, а та колонка порожня в кожного, хто не
  // відкривав Налаштування, і порожнє означало «українська». Тобто демо-візитер бачив
  // англійський екран і отримував українські відповіді AI, назви категорій і тексти помилок —
  // це читалось як зламаний продукт, а не як брак перекладу. Заголовок ще й робить перемикач
  // мови МИТТЄВИМ: не треба зберігати профіль, щоб модель почала відповідати інакше.
  baseQuery: fetchBaseQuery({
    baseUrl: "/api",
    prepareHeaders: (headers) => { headers.set("x-mt-locale", getLocale()); return headers; },
  }),
  tagTypes: ["Tx", "Account", "Summary", "Budget", "Planned", "Setup", "Me", "Insight", "Profile", "Advice", "Event", "Category", "Goal", "Report", "Fact", "Notification", "SavedFilter", "Knowledge", "Credentials", "AdminUsers", "Frequent", "Job", "Telegram", "Chat", "Feedback", "Backup", "Push"],
  endpoints: (b) => ({
    // `user` присутній лише коли `authenticated` — сесія тепер несе userId, і саме він
    // визначає, ЧИЯ база відкриється (PLATFORM.md §2).
    getMe: b.query<
      {
        authenticated: boolean;
        demo?: boolean; // ephemeral demo sandbox (P4.2) — drives the demo banner (P4.4)
        demo_expires_at?: number | null; // unix; banner countdown
        user?: { id: string; email: string | null; name: string | null; picture: string | null; is_owner: boolean };
      },
      void
    >({ query: () => "/me", providesTags: ["Me"] }),
    // (`login` removed 2026-07-26 — sign-in is Google-only and `POST /api/login` no longer
    //  exists on the server, so the mutation could only ever 404.)
    // Erasure: wipes this user's Durable Object and directory row, then drops the cookie.
    // Nothing to invalidate afterwards — the client navigates away to the logged-out shell.
    eraseMyData: b.mutation<{ ok: boolean }, void>({
      query: () => ({ url: "/account/delete", method: "POST", body: { confirm: "DELETE" } }),
    }),
    // Сесія stateless, тож `logout` чистить кукі лише в ЦЬОМУ браузері. Проти вкраденої
    // копії це нічого не дає — для того є `logout-all`, який інкрементує token_version.
    logoutAll: b.mutation<{ ok: boolean }, void>({
      query: () => ({ url: "/account/logout-all", method: "POST" }),
    }),
    logout: b.mutation<unknown, void>({
      query: () => ({ url: "/logout", method: "POST" }),
      invalidatesTags: ["Me"],
    }),
    getSummary: b.query<Summary, void>({ query: () => "/summary", providesTags: ["Summary"] }),
    getAccounts: b.query<Account[], void>({ query: () => "/accounts", providesTags: ["Account"] }),
    getArchivedAccounts: b.query<Account[], void>({ query: () => "/accounts/archived", providesTags: ["Account"] }),
    getFunds: b.query<FundsBreakdown, void>({ query: () => "/accounts/funds", providesTags: ["Account", "Summary"] }),
    getAccountsHistory: b.query<AccountHistory, void>({ query: () => "/accounts/history", providesTags: ["Account"] }),
    setAccountActive: b.mutation<unknown, { id: string; active: boolean }>({
      query: ({ id, active }) => ({ url: `/accounts/${id}/active`, method: "PATCH", body: { active } }),
      invalidatesTags: ["Account", "Summary"],
    }),
    deleteAccount: b.mutation<unknown, string>({
      query: (id) => ({ url: `/accounts/${id}`, method: "DELETE" }),
      invalidatesTags: ["Account", "Summary"],
    }),
    addManualAccount: b.mutation<{ ok: boolean; id: string }, { type: string; title: string; currency_code: number; balance: number; role?: "liquid" | "investment"; credit_limit?: number; ai_note?: string }>({
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
    setAccountMeta: b.mutation<unknown, { id: string; role?: "liquid" | "investment"; ai_note?: string; statement_day?: number | null; payment_day?: number | null; min_payment?: number | null }>({
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
    setEventBudget: b.mutation<{ ok: boolean }, { id: number; budget: number | null }>({
      query: ({ id, budget }) => ({ url: `/events/${id}`, method: "PATCH", body: { budget } }),
      invalidatesTags: ["Event"],
    }),
    getEvent: b.query<{
      event: EventGroup; transactions: TxRow[]; spent: number; income: number;
      // Plan line items (P2.3) — amounts in ₴ minor units.
      planned: { id: number; label: string; amount: number; category_id: number | null; category_name: string | null }[];
      planned_total: number;
    }, number>({
      query: (id) => `/events/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Event", id }],
    }),
    addEventPlanned: b.mutation<{ ok: boolean; id: number }, { id: number; label: string; amount: number; category_id?: number | null }>({
      query: ({ id, ...body }) => ({ url: `/events/${id}/planned`, method: "POST", body }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Event", id: arg.id }],
    }),
    deleteEventPlanned: b.mutation<{ ok: boolean }, { id: number; pid: number }>({
      query: ({ id, pid }) => ({ url: `/events/${id}/planned/${pid}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Event", id: arg.id }],
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
    // §PLATFORM P0.4 — свої ключі (mono / Anthropic). Значення НІКОЛИ не приходить назад,
    // лише статус: сервер не має способу віддати секрет клієнту, і це навмисно.
    getCredentials: b.query<{ secrets: CredentialStatus[] }, void>({
      query: () => "/credentials",
      providesTags: ["Credentials"],
    }),
    putCredential: b.mutation<{ ok: true; verified: boolean; detail: string | null }, { name: string; value: string }>({
      query: ({ name, value }) => ({ url: `/credentials/${name}`, method: "PUT", body: { value } }),
      invalidatesTags: ["Credentials", "Setup"],
    }),
    deleteCredential: b.mutation<{ ok: true }, string>({
      query: (name) => ({ url: `/credentials/${name}`, method: "DELETE" }),
      invalidatesTags: ["Credentials", "Setup"],
    }),
    // §PLATFORM P1.2 — CSV-імпорт. Два кроки навмисно: preview нічого не пише.
    csvPreview: b.mutation<{
      delimiter: string; headers: string[]; sample: string[][]; total_rows: number;
      mapping: { date?: number; amount?: number; description?: number; comment?: number | null; mcc?: number | null };
      complete: boolean; parsed?: number; duplicates?: number;
      skipped?: { line: number; reason: string }[]; skipped_total?: number;
      preview?: { time: number; amount: number; description: string | null }[];
    }, { text: string; account_id?: string; mapping?: Record<string, number | null | undefined> }>({
      query: (body) => ({ url: "/import/csv/preview", method: "POST", body }),
    }),
    csvCommit: b.mutation<{ ok: true; inserted: number; duplicates: number; skipped: number },
      { text: string; account_id: string; mapping?: Record<string, number | null | undefined> }>({
      query: (body) => ({ url: "/import/csv/commit", method: "POST", body }),
      invalidatesTags: ["Tx", "Summary", "Account", "Setup"],
    }),
    // §Хвіст: факт vs план по підписках.
    getPlannedActuals: b.query<PlannedActual[], void>({ query: () => "/planned/actuals", providesTags: ["Planned", "Tx"] }),
    // §Аналітика 2.0 — AI-репорти.
    getReports: b.query<ReportListItem[], { type?: ReportPeriodType } | void>({
      query: (arg) => `/reports${arg && arg.type ? `?type=${arg.type}` : ""}`,
      providesTags: ["Report"],
    }),
    getReport: b.query<ReportFull, number>({
      query: (id) => `/reports/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Report", id }],
    }),
    // `custom` carries explicit unix bounds; `week`/`month` carry a scope instead.
    generateReport: b.mutation<
      { ok: boolean; id: number; created: boolean },
      { type: ReportPeriodType; force?: boolean; scope?: "current" | "last"; from?: number; to?: number }
    >({
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
    getCurrencies: b.query<CurrenciesList, void>({ query: () => "/analytics/currencies" }),
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
    createGoal: b.mutation<{ ok: boolean; id: number }, GoalBody>({
      query: (body) => ({ url: "/goals", method: "POST", body }),
      invalidatesTags: ["Goal"],
    }),
    updateGoal: b.mutation<{ ok: boolean }, { id: number } & Partial<GoalBody>>({
      query: ({ id, ...body }) => ({ url: `/goals/${id}`, method: "PATCH", body }),
      invalidatesTags: ["Goal"],
    }),
    deleteGoal: b.mutation<unknown, number>({
      query: (id) => ({ url: `/goals/${id}`, method: "DELETE" }),
      invalidatesTags: ["Goal"],
    }),
    addTransaction: b.mutation<{ ok: boolean; id: string }, Record<string, unknown>>({
      query: (body) => ({ url: "/transactions", method: "POST", body }),
      invalidatesTags: ["Tx", "Summary", "Frequent"],
    }),
    // Paired transfer between own accounts (shared `transfer_pair_id`) — see the route comment.
    addTransfer: b.mutation<
      { ok: boolean; pair_id: string; ids: string[] },
      { from_account_id: string; to_account_id: string; amount: number; to_amount?: number; time?: number; user_note?: string }
    >({
      query: (body) => ({ url: "/transactions/transfer", method: "POST", body }),
      invalidatesTags: ["Tx", "Summary", "Account"],
    }),
    getFrequentTx: b.query<FrequentTx[], void>({
      query: () => "/transactions/frequent",
      providesTags: ["Frequent"],
    }),
    editTransaction: b.mutation<unknown, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `/transactions/${id}`, method: "PATCH", body }),
      invalidatesTags: (_r, _e, { id }) => ["Tx", { type: "Tx", id }, "Summary", "Event"],
    }),
    bulkEditTransactions: b.mutation<{ ok: boolean; updated: number }, { ids: string[]; event_id?: number | null; category_id?: number | null; is_transfer?: boolean; importance?: string | null; tag_ids?: number[] }>({
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
    // owner-only user administration (D2)
    getAdminUsers: b.query<{ users: AdminUser[]; signup: "open" | "invite" }, void>({
      query: () => "/admin/users",
      providesTags: ["AdminUsers"],
    }),
    // Counters normally land once a day from the cron; this is for the moment right after
    // telling somebody "sign up and try it", when a day-old number is the useless one.
    refreshAdminStats: b.mutation<{ ok: boolean; updated: number; failed: string[] }, void>({
      query: () => ({ url: "/admin/users/refresh-stats", method: "POST" }),
      invalidatesTags: ["AdminUsers"],
    }),
    inviteUser: b.mutation<{ ok: boolean }, string>({
      query: (email) => ({ url: "/admin/users/invite", method: "POST", body: { email } }),
      invalidatesTags: ["AdminUsers"],
    }),
    setUserStatus: b.mutation<{ ok: boolean }, { id: string; status: "active" | "disabled" }>({
      query: ({ id, status }) => ({ url: `/admin/users/${id}/status`, method: "POST", body: { status } }),
      invalidatesTags: ["AdminUsers"],
    }),
    // setup
    getSetupStatus: b.query<SetupStatus, void>({ query: () => "/setup/status", providesTags: ["Setup"] }),
    // ROADMAP L5: preview then apply — the mutation renames rows, so it must invalidate anything
    // that shows a merchant name (lists, aggregates, the merchant page).
    getTranslitFixes: b.query<{ fixes: TranslitFix[] }, void>({ query: () => "/setup/merchants/translit" }),
    applyTranslitFixes: b.mutation<{ fixed: number; merchants: number; aliases: number }, void>({
      query: () => ({ url: "/setup/merchants/translit", method: "POST" }),
      invalidatesTags: ["Tx", "Summary", "Category"],
    }),
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
    // §D1 — привʼязка ВЛАСНОГО чату. `owner_fallback` каже, що пуші і так ідуть у глобальний
    // чат власника: без нього «не привʼязано» читалось би як «не працює».
    getTelegramLink: b.query<{ configured: boolean; linked: boolean; owner_fallback: boolean }, void>({
      query: () => "/setup/telegram",
      providesTags: ["Telegram"],
    }),
    linkTelegram: b.mutation<{ url: string }, void>({
      query: () => ({ url: "/setup/telegram/link", method: "POST" }),
    }),
    unlinkTelegram: b.mutation<{ ok: boolean }, void>({
      query: () => ({ url: "/setup/telegram/unlink", method: "POST" }),
      invalidatesTags: ["Telegram"],
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
      // "Setup" too: the first-run checklist reads the cached-rate count from /setup/status, so
      // without it the step stays marked "not done" right after it succeeded.
      invalidatesTags: ["Summary", "Setup"],
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
    // §CHAT-SYNC: розмови з порадником живуть на сервері, а не в localStorage — тому телефон і
    // ноутбук бачать одну й ту саму стрічку. Відповідь моделі сюди НЕ ходить: вона стрімиться
    // через `lib/aiStream.ts` (у RTK Query немає стану «відповідь ще пишеться»).
    getChats: b.query<ChatSummary[], void>({ query: () => "/chats", providesTags: ["Chat"] }),
    getChat: b.query<ChatDetail, string>({
      query: (id) => `/chats/${encodeURIComponent(id)}`, providesTags: ["Chat"],
    }),
    createChat: b.mutation<{ ok: boolean }, { id: string; title?: string }>({
      query: (body) => ({ url: "/chats", method: "POST", body }), invalidatesTags: ["Chat"],
    }),
    renameChat: b.mutation<{ ok: boolean }, { id: string; title: string }>({
      query: ({ id, title }) => ({ url: `/chats/${encodeURIComponent(id)}`, method: "PATCH", body: { title } }),
      invalidatesTags: ["Chat"],
    }),
    deleteChat: b.mutation<{ ok: boolean }, string>({
      query: (id) => ({ url: `/chats/${encodeURIComponent(id)}`, method: "DELETE" }), invalidatesTags: ["Chat"],
    }),
    // Хід КОРИСТУВАЧА. Хід асистента пише сервер, коли відповідь готова (див. роут стріму).
    appendChatMessage: b.mutation<{ ok: boolean }, { id: string; content: string; title?: string }>({
      query: ({ id, ...body }) => ({ url: `/chats/${encodeURIComponent(id)}/messages`, method: "POST", body }),
      invalidatesTags: ["Chat"],
    }),
    truncateChat: b.mutation<{ ok: boolean }, { id: string; keep: number }>({
      query: ({ id, keep }) => ({ url: `/chats/${encodeURIComponent(id)}/truncate`, method: "POST", body: { keep } }),
      invalidatesTags: ["Chat"],
    }),
    importChats: b.mutation<{ imported: number }, { chats: unknown[] }>({
      query: (body) => ({ url: "/chats/import", method: "POST", body }), invalidatesTags: ["Chat"],
    }),
    // §PUSH: браузерні сповіщення. Сам пуш порожній — текст сервіс-воркер забирає вже по сесії
    // (див. `worker/lib/messaging/webpush.ts`), тож підписка це лише endpoint.
    getPushStatus: b.query<PushStatus, void>({ query: () => "/push/key", providesTags: ["Push"] }),
    subscribePush: b.mutation<{ ok: boolean }, string>({
      query: (endpoint) => ({ url: "/push/subscribe", method: "POST", body: { endpoint } }),
      invalidatesTags: ["Push"],
    }),
    unsubscribePush: b.mutation<{ ok: boolean }, string>({
      query: (endpoint) => ({ url: "/push/unsubscribe", method: "POST", body: { endpoint } }),
      invalidatesTags: ["Push"],
    }),
    testPush: b.mutation<PushSendResult, void>({ query: () => ({ url: "/push/test", method: "POST" }) }),
    // §BACKUP: копії даних поза Durable Object. Список і видалення — звичайні запити; сам файл
    // качається прямим посиланням (браузер має зберегти його на диск, а не покласти в стор).
    getBackups: b.query<BackupList, void>({ query: () => "/backups", providesTags: ["Backup"] }),
    runBackup: b.mutation<{ ok: boolean; size: number }, void>({
      query: () => ({ url: "/backups/run", method: "POST" }), invalidatesTags: ["Backup"],
    }),
    deleteBackup: b.mutation<{ ok: boolean }, string>({
      query: (name) => ({ url: `/backups/${encodeURIComponent(name)}`, method: "DELETE" }),
      invalidatesTags: ["Backup"],
    }),
    // Відновлення інвалідує ВСЕ: після нього в базі інші рядки, ніж ті, що зараз на екранах.
    restoreBackup: b.mutation<RestoreResult, { name?: string; file?: string }>({
      query: ({ name, file }) => ({
        url: `/backups/restore?confirm=RESTORE${name ? `&name=${encodeURIComponent(name)}` : ""}`,
        method: "POST",
        ...(file ? { body: file, headers: { "content-type": "application/json" } } : {}),
      }),
      invalidatesTags: (_r, _e) => ["Backup", "Tx", "Account", "Summary", "Budget", "Planned",
        "Setup", "Insight", "Advice", "Event", "Category", "Goal", "Report", "Fact",
        "Notification", "SavedFilter", "Knowledge", "Frequent", "Job", "Chat"],
    }),
    // Канал зворотного зв'язку. Відкритий і для демо: людина, яка вперше бачить застосунок, —
    // саме та, хто помітить незрозуміле, і форма, доступна лише після реєстрації, збирає відгуки
    // від тих, хто вже проминув зламане місце.
    getFeedbackContact: b.query<FeedbackContact, void>({ query: () => "/feedback/contact" }),
    sendFeedback: b.mutation<{ ok: boolean }, { kind: FeedbackKind; message: string; email?: string; page?: string }>({
      query: (body) => ({ url: "/feedback", method: "POST", body }), invalidatesTags: ["Feedback"],
    }),
    getAdminFeedback: b.query<AdminFeedback, void>({ query: () => "/admin/feedback", providesTags: ["Feedback"] }),
    markFeedbackHandled: b.mutation<{ ok: boolean }, { id: number; on: boolean }>({
      query: ({ id, on }) => ({ url: `/admin/feedback/${id}/handled`, method: "POST", body: { on } }),
      invalidatesTags: ["Feedback"],
    }),
    // Прибрати з денного лічильника демо власні заходи: власник відкриває пісочницю постійно,
    // тестуючи, і сам робить шум у єдиному числі, яке мало відповісти «чи хтось дивиться».
    discountDemoVisits: b.mutation<{ ok: boolean }, { day: string; n?: number }>({
      query: ({ day, n = 1 }) => ({ url: `/admin/feedback/demo/${day}/discount`, method: "POST", body: { n } }),
      invalidatesTags: ["Feedback"],
    }),
    // §A5: корпус знань — заводські доки + власні нотатки користувача.
    getKnowledge: b.query<KnowledgeList, void>({ query: () => "/knowledge", providesTags: ["Knowledge"] }),
    getKnowledgeDoc: b.query<KnowledgeDocFull, string>({ query: (id) => `/knowledge/${encodeURIComponent(id)}`, providesTags: ["Knowledge"] }),
    createKnowledgeDoc: b.mutation<{ ok: boolean; id: string }, { title: string; summary?: string; body: string }>({
      query: (body) => ({ url: "/knowledge", method: "POST", body }), invalidatesTags: ["Knowledge"],
    }),
    saveKnowledgeDoc: b.mutation<{ ok: boolean }, { id: string; title?: string; summary?: string; body: string; enabled?: boolean }>({
      query: ({ id, ...body }) => ({ url: `/knowledge/${encodeURIComponent(id)}`, method: "PUT", body }), invalidatesTags: ["Knowledge"],
    }),
    // Для власної нотатки — видалення; для заводського доку — повернення до заводського тексту.
    deleteKnowledgeDoc: b.mutation<{ ok: boolean }, string>({
      query: (id) => ({ url: `/knowledge/${encodeURIComponent(id)}`, method: "DELETE" }), invalidatesTags: ["Knowledge"],
    }),
    // §H: детермінований Індекс фінздоров'я. Провайдить Advice → перерахунок при зміні фактів/порад.
    getHealth: b.query<FinanceHealth, void>({ query: () => "/analytics/health", providesTags: ["Advice"] }),
    // Спарклайни (6-міс тренд у списках категорій/мерчантів). Оновлюється з новими операціями.
    getSpark: b.query<SparkData, void>({ query: () => "/analytics/spark", providesTags: ["Summary"] }),
    // §HABITS: що зʼявилось у регулярних витратах і що замовкло. Вікно фіксоване (9 міс) —
    // параметрів нема, тож і кешується один раз на зміну операцій.
    getHabits: b.query<Habits, void>({ query: () => "/analytics/habits", providesTags: ["Tx"] }),
    // §WEEKDAY: витрати за днями тижня. Тег `Tx` — правка операції може змінити і день, і суму.
    getWeekday: b.query<WeekdayAnalytics, { preset?: Preset; currency?: number | null } | void>({
      query: (a) => `/analytics/weekday?preset=${a?.preset ?? "month"}${a?.currency ? `&currency=${a.currency}` : ""}`,
      providesTags: ["Tx"],
    }),
    getMonthlyHistory: b.query<MonthlyHistory, { months?: number } | void>({
      query: (a) => `/analytics/monthly-history?months=${a?.months ?? 6}`,
      providesTags: ["Tx"],
    }),
    getAutoBudget: b.query<AutoBudget, { trim?: number } | void>({
      query: (a) => `/budgets/auto?trim=${a?.trim ?? 10}`,
      providesTags: ["Budget", "Tx"],
    }),
    applyAutoBudget: b.mutation<{ ok: boolean; applied: number }, { items: { category_id: number; amount: number }[] }>({
      query: (body) => ({ url: "/budgets/auto", method: "POST", body }),
      invalidatesTags: ["Budget", "Summary"],
    }),
    getSavedFilters: b.query<SavedFilter[], void>({
      query: () => "/settings/saved-filters", providesTags: ["SavedFilter"],
    }),
    saveFilter: b.mutation<SavedFilter[], { name: string; query: string }>({
      query: (body) => ({ url: "/settings/saved-filters", method: "POST", body }),
      invalidatesTags: ["SavedFilter"],
    }),
    deleteSavedFilter: b.mutation<SavedFilter[], string>({
      query: (id) => ({ url: `/settings/saved-filters/${id}`, method: "DELETE" }),
      invalidatesTags: ["SavedFilter"],
    }),
    search: b.query<SearchResults, string>({
      query: (q) => `/search?q=${encodeURIComponent(q)}`,
      providesTags: ["Tx"],
    }),
    getNetworth: b.query<Networth, number | void>({
      query: (months) => `/analytics/networth?months=${months ?? 12}`,
      providesTags: ["Summary", "Account"],
    }),
    // Cashflow-календар очікуваних списань. Залежить від планів/підписок і подушки.
    getCashflowCalendar: b.query<CashflowCalendar, { from?: number; to?: number } | void>({
      query: (a) => { const p = new URLSearchParams(); if (a?.from) p.set("from", String(a.from)); if (a?.to) p.set("to", String(a.to)); const q = p.toString(); return `/analytics/cashflow-calendar${q ? `?${q}` : ""}`; },
      providesTags: ["Summary", "Planned"],
    }),
    // §SPLIT: частини транзакції. Зміна рухає категорійну аналітику → інвалідуємо Tx/Summary/Advice.
    getTxSplits: b.query<TxSplit[], string>({ query: (id) => `/transactions/${id}/splits`, providesTags: (_r, _e, id) => [{ type: "Tx", id }] }),
    setTxSplits: b.mutation<{ ok: boolean; count: number }, { id: string; splits: { category_id: number; amount: number }[] }>({
      query: ({ id, splits }) => ({ url: `/transactions/${id}/splits`, method: "PUT", body: { splits } }),
      invalidatesTags: (_r, _e, { id }) => ["Tx", { type: "Tx", id }, "Summary", "Advice"],
    }),
    // §COMPENSATION: «мені скинули за це гроші». Міняє суму витрати в аналітиці → інвалідуємо
    // те саме, що й спліт (Tx/Summary/Advice), інакше Головна й Порадник лишились би зі старим числом.
    getReimbursement: b.query<Reimbursement, string>({
      query: (id) => `/transactions/${id}/reimbursement`,
      providesTags: (_r, _e, id) => [{ type: "Tx", id }],
    }),
    getReimbursementUsage: b.query<ReimbursementUsage, string>({
      query: (id) => `/transactions/${id}/reimbursement-usage`,
      providesTags: (_r, _e, id) => [{ type: "Tx", id }],
    }),
    // Розподіл міняє суму витрати І дохід джерела → інвалідуємо весь Tx, не лише цю операцію.
    setReimbursement: b.mutation<
      { ok: boolean; reimbursed: number },
      { id: string; manual_amount?: number | null; allocations: { source_id: string; amount?: number | null }[] }
    >({
      query: ({ id, ...body }) => ({ url: `/transactions/${id}/reimbursement`, method: "PUT", body }),
      invalidatesTags: (_r, _e, { id }) => ["Tx", { type: "Tx", id }, "Summary", "Advice"],
    }),
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
    // Центр сповіщень. Стрічку тягне і сторінка, і бейдж на дзвіночку — один тег «Notification».
    getNotifications: b.query<NotificationFeed, { kind?: string | null; limit?: number } | void>({
      query: (a) => {
        const p = new URLSearchParams();
        if (a?.kind) p.set("kind", a.kind);
        if (a?.limit) p.set("limit", String(a.limit));
        const q = p.toString();
        return `/notifications${q ? `?${q}` : ""}`;
      },
      providesTags: ["Notification"],
    }),
    markNotificationsRead: b.mutation<{ ok: boolean; unread: number }, number[]>({
      query: (ids) => ({ url: "/notifications/read", method: "POST", body: { ids } }),
      invalidatesTags: ["Notification"],
    }),
    markAllNotificationsRead: b.mutation<{ ok: boolean; unread: number }, void>({
      query: () => ({ url: "/notifications/read-all", method: "POST" }),
      invalidatesTags: ["Notification"],
    }),
    clearNotifications: b.mutation<{ ok: boolean }, void>({
      query: () => ({ url: "/notifications", method: "DELETE" }),
      invalidatesTags: ["Notification"],
    }),
    generateNotifications: b.mutation<{ created: number; pushed: number; pruned: number; skipped: string[] }, void>({
      query: () => ({ url: "/notifications/generate", method: "POST" }),
      invalidatesTags: ["Notification"],
    }),
    getNotifPrefs: b.query<NotifPrefs, void>({ query: () => "/notifications/prefs", providesTags: ["Notification"] }),
    setNotifPrefs: b.mutation<NotifPrefs, Partial<NotifPrefs>>({
      query: (body) => ({ url: "/notifications/prefs", method: "PUT", body }),
      invalidatesTags: ["Notification"],
    }),

    // §P2.1 — внески в ціль. `current` тепер SUM цих рядків, тож будь-яка мутація тут
    // інвалідує і сам список цілей.
    getGoalContributions: b.query<GoalContribution[], number>({
      query: (id) => `/goals/${id}/contributions`,
      providesTags: (_r, _e, id) => [{ type: "Goal", id }],
    }),
    addGoalContribution: b.mutation<{ ok: boolean; current: number }, { id: number; amount: number; note?: string }>({
      query: ({ id, ...body }) => ({ url: `/goals/${id}/contributions`, method: "POST", body }),
      invalidatesTags: (_r, _e, { id }) => ["Goal", { type: "Goal", id }],
    }),
    deleteGoalContribution: b.mutation<{ ok: boolean; current: number }, { id: number; cid: number }>({
      query: ({ id, cid }) => ({ url: `/goals/${id}/contributions/${cid}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, { id }) => ["Goal", { type: "Goal", id }],
    }),

    // §A6 — довгі AI-генерації у фоні. Ставимо задачу й одразу відпускаємо користувача;
    // `JobsProvider` сам довідається про «готово» і оновить потрібний екран.
    createJob: b.mutation<{ job_id: number; created: boolean }, { kind: AiJobKind; params?: unknown }>({
      query: (body) => ({ url: "/jobs", method: "POST", body }),
      invalidatesTags: ["Job"],
    }),
    getJobs: b.query<{ items: AiJob[] }, void>({
      query: () => "/jobs",
      providesTags: ["Job"],
    }),
    // Без інвалідації: тост уже показано, і зайвий рефетч лише повернув би той самий список.
    markJobSeen: b.mutation<{ ok: boolean }, number>({
      query: (id) => ({ url: `/jobs/${id}/seen`, method: "POST" }),
    }),
  }),
});

export const {
  useGetMeQuery,
  useLogoutMutation,
  useEraseMyDataMutation,
  useLogoutAllMutation,
  useGetSummaryQuery,
  useGetAccountsQuery,
  useGetArchivedAccountsQuery,
  useGetFundsQuery,
  useGetAccountsHistoryQuery,
  useAddManualAccountMutation,
  useEditManualAccountMutation,
  useSetAccountTitleMutation,
  useSetAccountMetaMutation,
  useSetAccountActiveMutation,
  useDeleteAccountMutation,
  useGetRatesQuery,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  useLazyGetCategoryUsageQuery,
  useGetEventsQuery,
  useGetEventQuery,
  useCreateEventMutation,
  useSetEventBudgetMutation,
  useAddEventPlannedMutation,
  useDeleteEventPlannedMutation,
  useDeleteEventMutation,
  useGetBudgetsQuery,
  useGetPlannedQuery,
  useGetAiUsageQuery,
  useGetCredentialsQuery,
  usePutCredentialMutation,
  useDeleteCredentialMutation,
  useCsvPreviewMutation,
  useCsvCommitMutation,
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
  useGetMonthlyHistoryQuery,
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
  useAddTransferMutation,
  useGetFrequentTxQuery,
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
  useGetAdminUsersQuery,
  useRefreshAdminStatsMutation,
  useInviteUserMutation,
  useSetUserStatusMutation,
  useGetTranslitFixesQuery,
  useApplyTranslitFixesMutation,
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
  useGetPushStatusQuery,
  useSubscribePushMutation,
  useUnsubscribePushMutation,
  useTestPushMutation,
  useGetBackupsQuery,
  useRunBackupMutation,
  useDeleteBackupMutation,
  useRestoreBackupMutation,
  useGetFeedbackContactQuery,
  useSendFeedbackMutation,
  useGetAdminFeedbackQuery,
  useMarkFeedbackHandledMutation,
  useDiscountDemoVisitsMutation,
  useGetChatsQuery,
  useGetChatQuery,
  useCreateChatMutation,
  useRenameChatMutation,
  useDeleteChatMutation,
  useAppendChatMessageMutation,
  useTruncateChatMutation,
  useImportChatsMutation,
  useGetKnowledgeQuery,
  useLazyGetKnowledgeDocQuery,
  useCreateKnowledgeDocMutation,
  useSaveKnowledgeDocMutation,
  useDeleteKnowledgeDocMutation,
  useGetHealthQuery,
  useGetSparkQuery,
  useGetWeekdayQuery,
  useGetHabitsQuery,
  useGetNetworthQuery,
  useLazySearchQuery,
  useLazyGetAutoBudgetQuery,
  useApplyAutoBudgetMutation,
  useGetSavedFiltersQuery,
  useSaveFilterMutation,
  useDeleteSavedFilterMutation,
  useGetCashflowCalendarQuery,
  useGetTxSplitsQuery,
  useSetTxSplitsMutation,
  useGetReimbursementQuery,
  useGetReimbursementUsageQuery,
  useSetReimbursementMutation,
  useAddFactMutation,
  useConfirmFactMutation,
  useDeleteFactMutation,
  useGetNotificationsQuery,
  useMarkNotificationsReadMutation,
  useMarkAllNotificationsReadMutation,
  useClearNotificationsMutation,
  useGenerateNotificationsMutation,
  useGetNotifPrefsQuery,
  useSetNotifPrefsMutation,
  useGetGoalContributionsQuery,
  useAddGoalContributionMutation,
  useDeleteGoalContributionMutation,
  useCreateJobMutation,
  useGetTelegramLinkQuery,
  useLinkTelegramMutation,
  useUnlinkTelegramMutation,
  useGetJobsQuery,
  useMarkJobSeenMutation,
} = api;
