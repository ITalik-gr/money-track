import { useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { dateFmt } from "../i18n/locale.ts";
import { useSearchParams } from "react-router-dom";
import {
  useGetCashProjectionQuery, useGetCurrenciesQuery, useGetOverviewQuery, useGetPeriodModeQuery, useSetPeriodModeMutation,
} from "../store/api.ts";
import { currencySign, formatMinor } from "../lib/format.ts";
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
  const d = new Date(from * 1000);
  if (range === "week") return 7;
  if (range === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (range === "quarter") {
    const q = Math.floor(d.getMonth() / 3);
    return Math.round((+new Date(d.getFullYear(), q * 3 + 3, 1) - +new Date(d.getFullYear(), q * 3, 1)) / 86400000);
  }
  return Math.round((+new Date(d.getFullYear() + 1, 0, 1) - +new Date(d.getFullYear(), 0, 1)) / 86400000);
}

// §i18n: NEVER `new Intl.*` inline — a formatter built at module scope freezes the locale it was
// imported with, and switching language would leave every date in the old one.
const monthLongFmt = dateFmt({ month: "long", year: "numeric" });

/** The CURRENT month as `YYYY-MM`, in the reader's own clock — the boundary `?ym=` may not cross. */
function curYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** `2026-07` ± n months, as `YYYY-MM`. */
function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
    // Local wall-clock month edges, not UTC: the server's own boundaries are Kyiv days (§APP_TZ),
    // and a UTC edge would pull three hours of the neighbouring month into the window.
    return { from: Math.floor(+new Date(y, m - 1, 1) / 1000), to: Math.floor(+new Date(y, m, 1) / 1000) };
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
  const savingsRate = data && data.summary.income > 0 ? Math.round((net / data.summary.income) * 100) : null;
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
  const untilTs = useMemo(() => {
    const d = new Date(from * 1000);
    return Math.floor(+new Date(d.getFullYear(), d.getMonth(), d.getDate() + periodLen) / 1000) - 1;
  }, [from, periodLen]);
  const { data: projection } = useGetCashProjectionQuery(
    { to, until: untilTs, currency }, { skip: !projectsAhead },
  );
  // Прогноз показуємо лише коли минуло ≥40% періоду — інакше лінійна екстраполяція темпу
  // рано в періоді роздуває цифру в рази (детальний, історично-якірний прогноз — на Головній/у Патернах).
  const projected = data && mode === "calendar" && days < periodLen && days >= periodLen * 0.4
    ? Math.round(avgDay * periodLen) : null;
  // A month label a person reads, in their own locale — never a raw `2026-07`.
  const ymLabel = ym ? monthLongFmt.format(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1)) : null;
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
        <div className="page-head-actions">
          {/* §MONTH-VIEW: in month mode the period controls are REPLACED, not merely ignored. A
              range picker still on screen while a named month decides the window is a control
              that does nothing — the same defect as `budgets.rollover` before §BUDGET-MEMORY. */}
          {ym ? (
            <div className="month-nav">
              {/* Chevrons, not the literal «‹ ›» glyphs. Those are text: they inherit the body
                  font, sit off the optical centre of a square button and change weight with the
                  typeface — which is why the stepper read as unfinished next to every other
                  control on the page, all of which are icon-drawn. */}
              <button className="seg-btn month-nav-arrow" aria-label={t("stats.month.prev")} title={t("stats.month.prev")}
                onClick={() => setParam("ym", shiftYm(ym, -1))}>
                <Icon name="chevron" size={16} />
              </button>
              <span className="month-nav-lbl">{ymLabel}</span>
              <button className="seg-btn month-nav-arrow next" aria-label={t("stats.month.next")} title={t("stats.month.next")}
                disabled={shiftYm(ym, 1) >= curYm()}
                onClick={() => setParam("ym", shiftYm(ym, 1))}>
                <Icon name="chevron" size={16} />
              </button>
              <button className="pill-toggle" onClick={() => setParams((prev) => {
                const p = new URLSearchParams(prev); p.delete("ym"); return p;
              }, { replace: true })}>
                <Icon name="calendar" size={14} />{t("stats.month.back")}
              </button>
            </div>
          ) : (
            <>
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
              {/* §MONTH-VIEW: the WAY IN. The mode shipped reachable only by typing `?ym=` into the
                  address bar or by finding a bar to click on another tab — i.e. a feature that
                  exists and cannot be found is a feature that does not exist. Opens the last
                  COMPLETE month; the ‹ › stepper takes over from there. */}
              {/* ⚠️ NOT another calendar pill. It sat next to the period-mode toggle wearing the
                  same shape AND the same calendar icon, and the owner could not tell them apart —
                  fairly, since they do unrelated things: one flips a SETTING, this one leaves for
                  another VIEW. It now carries the same chevron as the stepper it becomes, and the
                  accent outline says "this navigates" the way the toggle's plain one does not. */}
              <button className="pill-toggle month-open" title={t("stats.month.browseTip")}
                onClick={() => setParam("ym", shiftYm(curYm(), -1))}>
                <Icon name="chevron" size={14} />{t("stats.month.browse")}
              </button>
            </>
          )}
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
                <TopSpendDays series={data.series} sign={sign} from={from} to={to} currency={currency} />
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
                <WeekdaySpend preset={range} from={ymBounds?.from} to={ymBounds?.to} currency={currency} />
                {!ym && <Habits />}
                <DeeperAnalytics series={data.series} sign={sign} from={from} to={to} currency={currency} />
                {/* §SHAPE: what the period is MADE of — cheque sizes, what falls outside every
                    envelope, and what has no category at all. */}
                <SpendingShape from={from} to={to} currency={currency} sign={sign} />
                {/* §SPEND-PROFILE — quiet days, how few merchants are half the spending, and how
                    much went somewhere new. Beside §SHAPE because both describe the period rather
                    than its size. */}
                <SpendProfileBlock from={from} to={to} sign={sign} />
                <IncomeBreakdown preset={range} from={ymBounds?.from} to={ymBounds?.to} currency={currency} sign={sign} />
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
