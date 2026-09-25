import { useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { dateFmt } from "../i18n/locale.ts";
import { localDayStart, localMidnight, localMonthStart, localQuarterStart, localYearStart } from "../../shared/time.ts";
import { useSearchParams } from "react-router-dom";
import {
  useGetCashProjectionQuery, useGetCurrenciesQuery, useGetOverviewQuery, useGetPeriodModeQuery, useSetPeriodModeMutation,
} from "../store/api.ts";
import { formatMinor } from "../lib/format.ts";
import { signFor } from "../lib/currency.ts";
import { CashflowChart } from "../components/stats/CashflowChart.tsx";
import { CumulativeChart } from "../components/stats/CumulativeChart.tsx";
import { IncomeBreakdown } from "../components/stats/IncomeBreakdown.tsx";
import { MonthlyHistory } from "../components/stats/MonthlyHistory.tsx";
import { MonthStack } from "../components/stats/MonthStack.tsx";
import { SpendDonut } from "../components/stats/SpendDonut.tsx";
import { StatsSkeleton } from "../components/ui/Skeleton.tsx";
import { ReceiptItems } from "../components/stats/ReceiptItems.tsx";
import { PriceDrift } from "../components/stats/PriceDrift.tsx";
import { AiInsightCard } from "../components/advisor/AiInsightCard.tsx";
import { HoverTip } from "../components/ui/HoverTip.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { SpendTiming } from "../components/stats/SpendTiming.tsx";
import { Habits } from "../components/stats/Habits.tsx";
import { FactLabel, RANGES, labelFor, type Cur, type RangeKey } from "../components/stats/shared.tsx";
import { StatsPeriodBar, curYm } from "../components/stats/StatsPeriodBar.tsx";
import { ClickableKpis, ImportanceBreakdown, SpendingPatterns } from "../components/stats/StatsOverview.tsx";
import { FxCostCard } from "../components/stats/FxCostCard.tsx";
import { AvgCheckByCategory, CategoryBreakdown, PeriodCompare } from "../components/stats/StatsCategories.tsx";
import { toCumulative } from "../components/stats/StatsTrends.tsx";
import { SpendingShape } from "../components/stats/StatsShape.tsx";
import { AccountsBlock, EventsBlock, MerchantsBlock } from "../components/stats/StatsMerchants.tsx";
import { MonthCompare } from "../components/stats/StatsCompare.tsx";
import { SpendProfileBlock } from "../components/stats/SpendProfile.tsx";
import { IncomeSplit } from "../components/stats/IncomeSplit.tsx";
import { Momentum } from "../components/stats/Momentum.tsx";

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
  if (range === "week") return 7;
  // Kyiv calendar (§APP_TZ); rounding absorbs the one 23/25-hour day of a DST switch.
  const next = range === "month" ? localMonthStart(from, 1) : range === "quarter" ? localQuarterStart(from, 1) : localYearStart(from, 1);
  const start = range === "month" ? localMonthStart(from) : range === "quarter" ? localQuarterStart(from) : localYearStart(from);
  return Math.round((next - start) / 86400);
}

// §i18n: NEVER `new Intl.*` inline — a formatter built at module scope freezes the locale it was
// imported with, and switching language would leave every date in the old one.
const monthLongFmt = dateFmt({ month: "long", year: "numeric" });

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

  /**
   * §MONTH-VIEW (2026-08-27) — `?ym=2026-07` turns the WHOLE page into that month.
   *
   * The server already took explicit `from`/`to`/`bucket` whenever no `preset` was given, and
   * every period-scoped block below already accepts `{from, to, currency}` — so browsing a past
   * month needed no new endpoint, only a way to ask. Before this the page could compare one month
   * against another and never simply SHOW an earlier one, which is what the owner asked for:
   * «хочу саме місяці переглядати, і повний перегляд як сторінку статистики всю».
   *
   * ⚠️ A month is only honoured when it is genuinely PAST. `?ym=` pointing at the current month
   * would mean the same period twice under two mechanisms — and the two disagree, because the
   * preset path stops at TODAY while an explicit range would run to the month's end and quietly
   * divide by days that have not happened.
   */
  const ymParam = params.get("ym");
  const ym = ymParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(ymParam) && ymParam < curYm() ? ymParam : null;
  const ymBounds = useMemo(() => {
    if (!ym) return null;
    const [y, m] = ym.split("-").map(Number);
    // Kyiv month edges (§APP_TZ) — the server's own boundaries; neither UTC nor the browser's zone.
    return { from: localMidnight(y, m, 1), to: localMidnight(y, m + 1, 1) };
  }, [ym]);

  const [currency, setCurrency] = useState<Cur>(null); // null = rolled up into the display base
  const { data: currencies } = useGetCurrenciesQuery();
  const { data: pm } = useGetPeriodModeQuery();
  const [setPeriodMode] = useSetPeriodModeMutation();
  const mode = pm?.mode ?? "calendar";

  // A named month drops `preset` entirely — the two paths must never both be sent, or the server
  // answers for the preset and the page labels it with the month.
  const { data, isFetching, error, refetch } = useGetOverviewQuery(
    ymBounds ? { from: ymBounds.from, to: ymBounds.to, bucket: "day", currency } : { preset: range, currency },
  );
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
  // §savingsRatePct — THE SERVER'S number. This was the fifth spelling of the same three tokens:
  // `MonthPulse` gave up its copy («the FOURTH copy»), `MonthlyHistory` gave up the third, and the
  // AI report has quoted `savings_rate_pct` since July. Identical arithmetic today, which is
  // exactly what makes a second copy dangerous — the divergence arrives with the first edit to
  // either side, and `tsc` cannot see inside two agreeing expressions (§Інваріанти: one number,
  // one home; the golden files pin the server's).
  const savingsRate = data?.summary.savings_rate_pct ?? null;
  const topCat = data?.byCategory?.[0] ?? null;
  // §1b: середній чек + прогноз витрат на кінець періоду (лише календарний, поки період не завершено).
  const avgCheck = data && data.summary.n ? Math.round(data.summary.spend / data.summary.n) : 0;
  const periodLen = periodLength(range, mode, from);
  /**
   * §CASH-PROJ — the forecast tail of the cumulative chart, computed on the SERVER.
   *
   * Asked for only when there is something to project: a rolling window has no end to reach, a
   * finished month has no future, and a named past month (`ym`) least of all. `skip` rather than a
   * conditional hook — the request costs four queries, and a chart that is not drawing a forecast
   * has no business paying for one.
   */
  const projectsAhead = mode === "calendar" && !ym && days < periodLen;
  const untilTs = useMemo(() => localDayStart(from, periodLen) - 1, [from, periodLen]);
  const { data: projection } = useGetCashProjectionQuery(
    { to, until: untilTs, currency }, { skip: !projectsAhead },
  );
  // Прогноз показуємо лише коли минуло ≥40% періоду — інакше лінійна екстраполяція темпу
  // рано в періоді роздуває цифру в рази (детальний, історично-якірний прогноз — на Головній/у Патернах).
  const projected = data && mode === "calendar" && days < periodLen && days >= periodLen * 0.4
    ? Math.round(avgDay * periodLen) : null;
  // A month label a person reads, in their own locale — never a raw `2026-07`.
  const ymLabel = ym ? monthLongFmt.format(new Date(`${ym}-15T12:00:00Z`)) : null;
  const periodNote = mode === "calendar"
    ? t(({ week: "stats.period.week", month: "stats.period.month", quarter: "stats.period.quarter", year: "stats.period.year" } as const)[range])
    : t("stats.period.rolling", { days: RANGES[range].days });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("stats.title")}</div>
          <div className="sub">{t("stats.sub")} · {ymLabel ?? periodNote}</div>
        </div>
        <StatsPeriodBar
          range={range} mode={mode} ym={ym} ymLabel={ymLabel}
          currency={currency} currencies={currencies}
          onRange={(k) => setParam("range", k)}
          onToggleMode={() => setPeriodMode(mode === "calendar" ? "rolling" : "calendar")}
          onYm={(next) => setParams((prev) => {
            const p = new URLSearchParams(prev);
            if (next == null) p.delete("ym"); else p.set("ym", next);
            return p;
          }, { replace: true })}
          onCurrency={setCurrency}
        />
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as TabKey[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setParam("tab", k)}>
            {t(TABS[k])}
          </button>
        ))}
      </div>

      <div className="stack" style={{ gap: 18 }}>
        {/* Said out loud rather than left to be noticed: a block that vanishes without explanation
            reads as a bug, and this one vanishes on purpose. */}
        {ym && <div className="month-note label">{t("stats.month.nowOnly", { month: ymLabel ?? "" })}</div>}
        {!data && isFetching && <StatsSkeleton />}
        {/* Без цієї гілки впалий запит давав просто порожню сторінку без пояснення. */}
        <ErrorNote error={error} what={t("stats.error")} onRetry={refetch} />
        {!data && !isFetching && !error && <div className="empty">{t("stats.emptyPeriod")}</div>}

        {data && (
          <>
            {tab === "overview" && (
              <>
                {/* §MONTH-VIEW: these four describe TODAY, not the month being read — the AI
                    insight is generated over a trailing window, FX cost and price drift over their
                    own, habits over the last complete months, and the monthly-history strip always
                    ends at now. Printing any of them under a July heading is the app answering a
                    question about July with a figure about August (§CAT-PAGE's rule). */}
                {!ym && <AiInsightCard days={days} />}
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
                {/* §INCOME-SPLIT — the SAME three bands, against income instead of against
                    spending. Directly under the breakdown on purpose: it is the question that
                    one raises and cannot answer. */}
                <IncomeSplit from={from} to={to} sign={sign} />
                {/* §MONTH-VIEW: «Радар темпу» projects the month IN PROGRESS — there is no pace
                    left to project in a month that has ended, and printing this month's radar
                    under July's heading is the §CAT-PAGE rule broken outright. */}
                {!ym && <SpendingPatterns />}
                {!ym && <FxCostCard />}
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
                <ReceiptItems from={from} to={to} />
                {!ym && <PriceDrift />}
                {/* §MOMENTUM: a run of complete months, so it is hidden in month mode for the
                    same reason as every other "about now" block — its answer is about the last
                    months, not about the month being read (§MONTH-VIEW). */}
                {!ym && <Momentum sign={sign} />}
                <PeriodCompare range={range} mode={mode} ym={ym} currency={currency} sign={sign} />
              </>
            )}

            {tab === "trends" && (
              <>
                {!ym && <MonthlyHistory />}
                {/* §MONTH-STACK — how much each month cost AND what it was made of, joined. Also
                    the way IN to a past month: clicking a bar sets `?ym=`. */}
                {!ym && <MonthStack />}
                <section>
                  <div className="section-head"><h2>{t("stats.trends.title")}</h2><span className="label">{t("stats.trends.sub")}</span></div>
                  <div className="card cashflow"><CashflowChart rows={rows} height={240} /></div>
                </section>
                {/* ST3: where the money COMES from sits right under income vs spend — it was the last
                    block of the tab, below eight blocks about spending. */}
                <IncomeBreakdown preset={range} from={ymBounds?.from} to={ymBounds?.to} currency={currency} sign={sign} />
                <section>
                  <div className="section-head">
                    <h2>{t("stats.cumulative.title")}</h2>
                    <HoverTip content={<>{t("stats.cumulative.tip")}</>}>
                      <span className="label">{t("common.whatIsThis")}</span>
                    </HoverTip>
                  </div>
                  <div className="card cashflow"><CumulativeChart rows={toCumulative(data.series, projection)} sign={sign} height={220} /></div>
                  {/* §CASH-PROJ: what the dashed line is built from, said in one line. A forecast
                      that will not say what it knows is a forecast nobody can argue with — and the
                      previous one was wrong precisely because it knew nothing. */}
                  {projection && (
                    <p className="muted proj-note">
                      {projection.has_events ? t("stats.cumulative.projWith") : t("stats.cumulative.projFlat")}
                    </p>
                  )}
                </section>
                {/* ST2: one «when» block instead of five (top days, patterns, weekdays). */}
                <SpendTiming series={data.series} sign={sign} from={from} to={to} currency={currency} />
                {!ym && <Habits />}
                {/* §SHAPE: what the period is MADE of — cheque sizes, what falls outside every
                    envelope, and what has no category at all. */}
                <SpendingShape from={from} to={to} currency={currency} sign={sign} />
                {/* §SPEND-PROFILE — quiet days, how few merchants are half the spending, and how
                    much went somewhere new. Beside §SHAPE because both describe the period rather
                    than its size. */}
                <SpendProfileBlock from={from} to={to} sign={sign} />
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
