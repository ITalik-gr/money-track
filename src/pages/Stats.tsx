import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { useSearchParams } from "react-router-dom";
import {
  useGetCurrenciesQuery, useGetOverviewQuery, useGetPeriodModeQuery, useSetPeriodModeMutation,
} from "../store/api.ts";
import { currencySign, formatMinor } from "../lib/format.ts";
import { signFor } from "../lib/currency.ts";
import { CashflowChart } from "../components/stats/CashflowChart.tsx";
import { CumulativeChart } from "../components/stats/CumulativeChart.tsx";
import { IncomeBreakdown } from "../components/stats/IncomeBreakdown.tsx";
import { MonthlyHistory } from "../components/stats/MonthlyHistory.tsx";
import { SpendDonut } from "../components/stats/SpendDonut.tsx";
import { StatsSkeleton } from "../components/ui/Skeleton.tsx";
import { ReceiptItems } from "../components/stats/ReceiptItems.tsx";
import { PriceDrift } from "../components/stats/PriceDrift.tsx";
import { AiInsightCard } from "../components/advisor/AiInsightCard.tsx";
import { HoverTip } from "../components/ui/HoverTip.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { Select } from "../components/ui/Select.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { WeekdaySpend } from "../components/stats/WeekdaySpend.tsx";
import { Habits } from "../components/stats/Habits.tsx";
import { FactLabel, RANGES, labelFor, type Cur, type RangeKey } from "../components/stats/shared.tsx";
import { ClickableKpis, ImportanceBreakdown, SpendingPatterns } from "../components/stats/StatsOverview.tsx";
import { FxCostCard } from "../components/stats/FxCostCard.tsx";
import { AvgCheckByCategory, CategoryBreakdown, PeriodCompare } from "../components/stats/StatsCategories.tsx";
import { DeeperAnalytics, TopSpendDays, toCumulative } from "../components/stats/StatsTrends.tsx";
import { AccountsBlock, EventsBlock, MerchantsBlock } from "../components/stats/StatsMerchants.tsx";
import { MonthCompare } from "../components/stats/StatsCompare.tsx";

/**
 * The Statistics page — the SHELL, since 2026-08-08.
 *
 * It was 1 379 lines, the largest file in the project, and by then it was not a page: it was five
 * pages sharing a header. What it holds now is exactly what all five tabs genuinely share — the
 * period, the currency, the period mode, and the ONE `/analytics/overview` request every tab reads
 * — plus the composition of each tab. The blocks themselves live in `components/stats/`.
 *
 * The cut follows the TABS and nothing else. That is the boundary the reader already sees and the
 * one that decides what is on screen; any other seam would have produced files whose names had to
 * be invented.
 *
 * ⚠️ The shared query stays HERE and is passed down. Letting each tab fetch its own overview would
 * read as tidier, and would mean four tabs re-requesting the same period on every switch — and,
 * worse, two tabs able to disagree about the same numbers for as long as one of them was stale.
 */

const TABS = {
  overview: "stats.tab.overview",
  categories: "stats.tab.categories",
  trends: "stats.tab.trends",
  merchants: "stats.tab.merchants",
  compare: "stats.tab.compare",
} as const;
type TabKey = keyof typeof TABS;

// §1b: повна довжина періоду в днях (для прогнозу «на кінець»). Ковзний = фіксовані вікна.
function periodLength(range: RangeKey, mode: "calendar" | "rolling", from: number): number {
  if (mode === "rolling") return RANGES[range].days;
  const d = new Date(from * 1000);
  if (range === "week") return 7;
  if (range === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (range === "quarter") {
    const q = Math.floor(d.getMonth() / 3);
    return Math.round((+new Date(d.getFullYear(), q * 3 + 3, 1) - +new Date(d.getFullYear(), q * 3, 1)) / 86400000);
  }
  return Math.round((+new Date(d.getFullYear() + 1, 0, 1) - +new Date(d.getFullYear(), 0, 1)) / 86400000);
}

export function Stats() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range");
  const range: RangeKey = rangeParam && rangeParam in RANGES ? (rangeParam as RangeKey) : "month";
  const tabParam = params.get("tab");
  const tab: TabKey = tabParam && tabParam in TABS ? (tabParam as TabKey) : "overview";
  const setParam = (key: string, val: string) => setParams((prev) => {
    const p = new URLSearchParams(prev); p.set(key, val); return p;
  }, { replace: true });

  const [currency, setCurrency] = useState<Cur>(null); // null = rolled up into the display base
  const { data: currencies } = useGetCurrenciesQuery();
  const { data: pm } = useGetPeriodModeQuery();
  const [setPeriodMode] = useSetPeriodModeMutation();
  const mode = pm?.mode ?? "calendar";

  const { data, isFetching, error, refetch } = useGetOverviewQuery({ preset: range, currency });
  // §BASE-CUR: `currency` is null in the DEFAULT mode ("rolled up"), and rolled up is the reader's
  // base — not the hryvnia. This single expression is threaded into every block on the page, so
  // `?? 980` here signed all five tabs with ₴ while the numbers under it were dollars.
  const sign = signFor(currency);

  // Межі періоду беремо з відповіді (сервер рахує за period_mode) — узгоджено з Головною.
  const from = data?.range.from ?? Math.floor(Date.now() / 1000) - RANGES[range].days * 86400;
  const to = data?.range.to ?? Math.floor(Date.now() / 1000);
  const days = Math.max(1, Math.round((to - from) / 86400));

  const rows = (data?.series ?? []).map((s) => ({ label: labelFor(s.bucket), spend: s.spend / 100, income: s.income / 100 }));
  const merchMax = Math.max(...(data?.byMerchant ?? []).map((m) => m.spent), 1);
  const net = (data?.summary.income ?? 0) - (data?.summary.spend ?? 0);
  const avgDay = data ? Math.round(data.summary.spend / days) : 0;
  const savingsRate = data && data.summary.income > 0 ? Math.round((net / data.summary.income) * 100) : null;
  const topCat = data?.byCategory?.[0] ?? null;
  // §1b: середній чек + прогноз витрат на кінець періоду (лише календарний, поки період не завершено).
  const avgCheck = data && data.summary.n ? Math.round(data.summary.spend / data.summary.n) : 0;
  const periodLen = periodLength(range, mode, from);
  // Прогноз показуємо лише коли минуло ≥40% періоду — інакше лінійна екстраполяція темпу
  // рано в періоді роздуває цифру в рази (детальний, історично-якірний прогноз — на Головній/у Патернах).
  const projected = data && mode === "calendar" && days < periodLen && days >= periodLen * 0.4
    ? Math.round(avgDay * periodLen) : null;
  const periodNote = mode === "calendar"
    ? t(({ week: "stats.period.week", month: "stats.period.month", quarter: "stats.period.quarter", year: "stats.period.year" } as const)[range])
    : t("stats.period.rolling", { days: RANGES[range].days });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("stats.title")}</div>
          <div className="sub">{t("stats.sub")} · {periodNote}</div>
        </div>
        <div className="page-head-actions">
          <div className="seg">
            {(Object.keys(RANGES) as RangeKey[]).map((k) => (
              <button key={k} className={`seg-btn ${range === k ? "active" : ""}`} onClick={() => setParam("range", k)}>
                {t(RANGES[k].labelKey)}
              </button>
            ))}
          </div>
          <button className="pill-toggle" title={t("stats.modeTip")}
            onClick={() => setPeriodMode(mode === "calendar" ? "rolling" : "calendar")}>
            <Icon name={mode === "calendar" ? "calendar" : "repeat"} size={14} />
            {mode === "calendar" ? t("stats.mode.calendar") : t("stats.mode.rolling")}
          </button>
          {currencies && currencies.length > 1 && (
            <Select
              className="ph-cur-sel"
              value={currency ?? "all"}
              options={[{ value: "all", label: t("stats.curUah") }, ...currencies.map((c) => ({ value: c, label: currencySign(c) }))]}
              onChange={(v) => setCurrency(v === "all" ? null : Number(v))}
            />
          )}
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as TabKey[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setParam("tab", k)}>
            {t(TABS[k])}
          </button>
        ))}
      </div>

      <div className="stack" style={{ gap: 18 }}>
        {!data && isFetching && <StatsSkeleton />}
        {/* Без цієї гілки впалий запит давав просто порожню сторінку без пояснення. */}
        <ErrorNote error={error} what={t("stats.error")} onRetry={refetch} />
        {!data && !isFetching && !error && <div className="empty">{t("stats.emptyPeriod")}</div>}

        {data && (
          <>
            {tab === "overview" && (
              <>
                <AiInsightCard days={days} />
                <ClickableKpis data={data} sign={sign} net={net} avgDay={avgDay} from={from} to={to} currency={currency} />
                <div className="stat-facts">
                  <div className="fact">
                    <FactLabel>{t("stats.fact.txCount")}</FactLabel>
                    <span className="fact-val">{data.summary.n}</span>
                  </div>
                  <div className="fact">
                    <FactLabel info={<>{t("stats.fact.savingsRateInfo")}</>}>{t("stats.fact.savingsRate")}</FactLabel>
                    <span className={`fact-val ${savingsRate != null ? (savingsRate >= 0 ? "pos" : "neg") : ""}`}>
                      {savingsRate != null ? `${savingsRate}%` : "—"}
                    </span>
                  </div>
                  <div className="fact">
                    <FactLabel info={<>{t("stats.fact.topCatInfo")}</>}>{t("stats.fact.topCat")}</FactLabel>
                    <span className="fact-val fact-cat">
                      {topCat ? (<><span className="d" style={{ background: topCat.color ?? "var(--accent)" }} />{topCat.category_name ?? "—"} · {formatMinor(topCat.spent, { decimals: false })} {sign}</>) : "—"}
                    </span>
                  </div>
                  <div className="fact">
                    <FactLabel info={<>{t("stats.fact.avgCheckInfo")}</>}>{t("stats.fact.avgCheck")}</FactLabel>
                    <span className="fact-val">{avgCheck ? `${formatMinor(avgCheck, { decimals: false })} ${sign}` : "—"}</span>
                  </div>
                  {projected != null && (
                    <div className="fact">
                      <FactLabel info={<>{t("stats.fact.projectedInfo")}</>}>{t("stats.fact.projected")}</FactLabel>
                      <span className="fact-val">≈{formatMinor(projected, { decimals: false })} {sign}</span>
                    </div>
                  )}
                </div>
                <ImportanceBreakdown data={data} sign={sign} from={from} to={to} currency={currency} />
                <SpendingPatterns />
                <FxCostCard sign={sign} />
                <section>
                  <div className="section-head"><h2>{t("stats.cashflow.title")}</h2><span className="label">{t("stats.cashflow.sub")}</span></div>
                  <div className="card cashflow">
                    <div className="legend" style={{ justifyContent: "flex-end", padding: "2px 4px 8px" }}>
                      <span><span className="d" style={{ background: "var(--chart-income)" }} />{t("common.income")}</span>
                      <span><span className="d" style={{ background: "var(--chart-expense)" }} />{t("common.expenses")}</span>
                    </div>
                    <CashflowChart rows={rows} height={240} />
                  </div>
                </section>
              </>
            )}

            {tab === "categories" && (
              <>
                <section>
                  <div className="section-head"><h2>{t("stats.byCategory.title")}</h2><InfoTip>{t("stats.byCategory.tip")}</InfoTip><span className="label">{t("stats.byCategory.click")}</span></div>
                  {data.byCategory.length ? (
                    <div className="cat-with-donut">
                      <SpendDonut rows={data.byCategory} sign={sign} />
                      <CategoryBreakdown rows={data.byCategory} from={from} to={to} currency={currency} sign={sign} />
                    </div>
                  ) : <div className="card empty">{t("stats.byCategory.empty")}</div>}
                </section>
                <AvgCheckByCategory rows={data.byCategory} sign={sign} />
                <ReceiptItems from={from} to={to} sign={sign} />
                <PriceDrift />
                <PeriodCompare range={range} mode={mode} currency={currency} sign={sign} />
              </>
            )}

            {tab === "trends" && (
              <>
                <MonthlyHistory />
                <section>
                  <div className="section-head"><h2>{t("stats.trends.title")}</h2><span className="label">{t("stats.trends.sub")}</span></div>
                  <div className="card cashflow"><CashflowChart rows={rows} height={240} /></div>
                </section>
                <TopSpendDays series={data.series} sign={sign} from={from} to={to} currency={currency} />
                <section>
                  <div className="section-head">
                    <h2>{t("stats.cumulative.title")}</h2>
                    <HoverTip content={<>{t("stats.cumulative.tip")}</>}>
                      <span className="label">{t("common.whatIsThis")}</span>
                    </HoverTip>
                  </div>
                  <div className="card cashflow"><CumulativeChart rows={toCumulative(data.series, { mode, to, days, periodLen })} sign={sign} height={220} /></div>
                </section>
                <WeekdaySpend preset={range} currency={currency} />
                <Habits />
                <DeeperAnalytics series={data.series} sign={sign} from={from} to={to} currency={currency} />
                <IncomeBreakdown preset={range} currency={currency} sign={sign} />
              </>
            )}

            {tab === "merchants" && (
              <>
                <div className="stats-2col">
                  <MerchantsBlock data={data} sign={sign} merchMax={merchMax} />
                  <EventsBlock data={data} from={from} to={to} currency={currency} sign={sign} />
                </div>
                <AccountsBlock data={data} from={from} to={to} currency={currency} sign={sign} />
              </>
            )}

            {tab === "compare" && <MonthCompare currency={currency} sign={sign} />}
          </>
        )}
      </div>
    </>
  );
}
