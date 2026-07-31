import { useMemo, useState, type ReactNode } from "react";
import { getLocale, dateFmt } from "../i18n/locale.ts";
import { useT, translate } from "../i18n/index.ts";
import { useSearchParams, Link } from "react-router-dom";
import { useGetCurrenciesQuery, useGetOverviewQuery, useGetCategoryDrillQuery, useGetSliceDrillQuery, useGetTransfersStatusQuery, useGetCompareQuery, useGetPatternsQuery, useGetPeriodModeQuery, useSetPeriodModeMutation, useGetSparkQuery } from "../store/api.ts";
import { Sparkline } from "../components/ui/Sparkline.tsx";
import type { Overview, DrillTx } from "../store/api.ts";
import { TransferReviewModal } from "../components/transactions/TransferReviewModal.tsx";
import { currencySign, formatMinor, formatDate, monthShort } from "../lib/format.ts";
import { CashflowChart } from "../components/stats/CashflowChart.tsx";
import { CumulativeChart } from "../components/stats/CumulativeChart.tsx";
import { IncomeBreakdown } from "../components/stats/IncomeBreakdown.tsx";
import { MonthlyHistory } from "../components/stats/MonthlyHistory.tsx";
import { SpendDonut } from "../components/stats/SpendDonut.tsx";
import { StatsSkeleton, SkeletonRows } from "../components/ui/Skeleton.tsx";
import { ReceiptItems } from "../components/stats/ReceiptItems.tsx";
import { PriceDrift } from "../components/stats/PriceDrift.tsx";
import { AiInsightCard } from "../components/advisor/AiInsightCard.tsx";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { EmptyCard } from "../components/ui/EmptyCard.tsx";
import { TxItem } from "../components/transactions/TxItem.tsx";
import { HoverTip } from "../components/ui/HoverTip.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { Select } from "../components/ui/Select.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { cardKind, cardKindLabel, cardLast4 } from "../lib/merchant.ts";
import { IMPORTANCE_LEVELS, IMPORTANCE_META, type Importance } from "../lib/importance.ts";

const RANGES = {
  week: { labelKey: "stats.range.week", days: 7 },
  month: { labelKey: "stats.range.month", days: 30 },
  quarter: { labelKey: "stats.range.quarter", days: 90 },
  year: { labelKey: "stats.range.year", days: 365 },
} as const;
type RangeKey = keyof typeof RANGES;

const TABS = {
  overview: "stats.tab.overview",
  categories: "stats.tab.categories",
  trends: "stats.tab.trends",
  merchants: "stats.tab.merchants",
  compare: "stats.tab.compare",
} as const;
type TabKey = keyof typeof TABS;

// Localized short weekday names (0=Sun..6=Sat). Used both as tooltips and inline labels
// in deeper-analytics charts; keeps the live locale in sync.
function weekdayShort(idx: number): string {
  return dateFmt({ weekday: "short" }).format(new Date(2021, 0, 3 + idx));
}
function weekdayLong(idx: number): string {
  return dateFmt({ weekday: "long" }).format(new Date(2021, 0, 3 + idx));
}

const FALLBACK = ["#1f6e4c", "#2e6be6", "#7a3e9d", "#c9871a", "#b23a2e", "#127c86", "#6b7a74"];
// currency=null → зведено в ₴. Знак завжди по обраній валюті (₴ для зведення).
type Cur = number | null;
type MoverRow = { name: string; color: string | null; a: number; b: number; delta: number };
type Movers = { up: MoverRow[]; down: MoverRow[] };

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

function labelFor(bucket: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) { const [, m, d] = bucket.split("-"); return `${d}.${m}`; }
  if (/^\d{4}-W\d+$/.test(bucket)) return translate(getLocale(), "stats.weekAbbr") + bucket.split("-W")[1];
  if (/^\d{4}-\d{2}$/.test(bucket)) return monthShort(Number(bucket.split("-")[1]) - 1) ?? bucket;
  return bucket;
}

// Localized full month name (0=Jan..11=Dec) for month-comparison labels.
function monthLong(monthIndex0: number): string {
  return dateFmt({ month: "long" }).format(new Date(2021, monthIndex0, 1));
}

// §1: накопичена чиста різниця (надходження − витрати) по бакетах — для running-balance лінії.
// opts (лише календарний, незавершений період, денні бакети) додає прогноз-хвіст (proj):
// пунктир на решту днів періоду за середнім денним темпом.
type CumPoint = { label: string; cum: number | null; proj?: number | null };
function toCumulative(series: Overview["series"], opts?: { mode: string; to: number; days: number; periodLen: number }): CumPoint[] {
  let acc = 0;
  const rows: CumPoint[] = series.map((s) => { acc += (s.income - s.spend) / 100; return { label: labelFor(s.bucket), cum: Math.round(acc) }; });
  const daily = series.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  if (!opts || opts.mode !== "calendar" || !daily || rows.length < 2) return rows;
  const remaining = opts.periodLen - opts.days;
  if (remaining <= 0) return rows;
  const lastCum = rows[rows.length - 1].cum ?? 0;
  // Нахил — МЕДІАНА денного нетто, не середнє. Середнє (= lastCum/days) розмазує разовий
  // лумп (напр. зайшла +31k зарплата одного дня) як щоденний приплив і тягне пунктир угору,
  // ніби дохід капає щодня. Медіана відкидає такий одноденний викид → нахил відображає
  // звичайний темп (переважно витрати), тож після разового поповнення лінія йде вниз.
  const nets = series.map((s) => (s.income - s.spend) / 100).sort((a, b) => a - b);
  const mid = Math.floor(nets.length / 2);
  const slope = nets.length % 2 ? nets[mid] : (nets[mid - 1] + nets[mid]) / 2;
  rows[rows.length - 1].proj = lastCum; // місток від фактичної точки до пунктиру
  const d = new Date(opts.to * 1000);
  const dm = dateFmt({ day: "numeric", month: "numeric" });
  for (let i = 1; i <= remaining; i++) {
    d.setDate(d.getDate() + 1);
    rows.push({ label: dm.format(d).replace(/\s/g, ""), cum: null, proj: Math.round(lastCum + slope * i) });
  }
  return rows;
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

  const [currency, setCurrency] = useState<Cur>(null); // null = ₴ зведено
  const { data: currencies } = useGetCurrenciesQuery();
  const { data: pm } = useGetPeriodModeQuery();
  const [setPeriodMode] = useSetPeriodModeMutation();
  const mode = pm?.mode ?? "calendar";

  const { data, isFetching, error, refetch } = useGetOverviewQuery({ preset: range, currency });
  const sign = currencySign(currency ?? 980);

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

// Клікабельні KPI: клік на «Витрати»/«Надходження» → повний список операцій, що рахуються.
function ClickableKpis({ data, sign, net, avgDay, from, to, currency }: {
  data: Overview; sign: string; net: number; avgDay: number; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [open, setOpen] = useState<"expense" | "income" | null>(null);
  return (
    <>
      <div className="stat-kpis">
        <button type="button" className={`card kpi-tile kpi-click ${open === "expense" ? "open" : ""}`} onClick={() => setOpen(open === "expense" ? null : "expense")}>
          <StatKpiInner title={t("stats.kpi.spend")} minor={data.summary.spend} prev={data.prev.spend} sign={sign} goodWhenUp={false}
            info={<>{t("stats.kpi.spendInfo")}</>} />
        </button>
        <button type="button" className={`card kpi-tile kpi-click ${open === "income" ? "open" : ""}`} onClick={() => setOpen(open === "income" ? null : "income")}>
          <StatKpiInner title={t("stats.kpi.income")} minor={data.summary.income} prev={data.prev.income} sign={sign} goodWhenUp
            info={<>{t("stats.kpi.incomeInfo")}</>} />
        </button>
        <div className="card kpi-tile">
          <StatKpiInner title={t("stats.kpi.net")} minor={net} sign={sign} tone={net >= 0 ? "pos" : "neg"}
            info={<>{t("stats.kpi.netInfo")}</>} />
        </div>
        <div className="card kpi-tile">
          <StatKpiInner title={t("stats.kpi.avgDay")} minor={avgDay} sign={sign}
            info={<>{t("stats.kpi.avgDayInfo")}</>} />
        </div>
      </div>
      {open && (
        <div className="card drill-open-card">
          <div className="label" style={{ marginBottom: 6 }}>
            {(open === "expense" ? t("stats.drill.allSpend") : t("stats.drill.allIncome")) + " " + t("stats.drill.period")}
          </div>
          <SliceDrillPanel dim="all" type={open} from={from} to={to} currency={currency} sign={sign} embedded />
        </div>
      )}
    </>
  );
}

// Розбивка по категоріях із drill-down (клік → підкатегорії + мерчанти) і винесенням
// «Перекази і зняття» як вторинної (§F2 крок 1 — не роздуває основний розподіл).
const isSecondaryCat = (name: string | null) => /переказ|зняття/i.test(name ?? "");

function CategoryBreakdown({ rows, from, to, currency, sign }: {
  rows: Overview["byCategory"]; from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const [openId, setOpenId] = useState<number | null>(null);
  const { data: spark } = useGetSparkQuery();
  const primary = rows.filter((r) => !isSecondaryCat(r.category_name));
  const secondary = rows.filter((r) => isSecondaryCat(r.category_name));
  const total = primary.reduce((a, c) => a + c.spent, 0) || 1;
  const noCat = t("common.uncategorized");

  const bar = (e: Overview["byCategory"][number], i: number, secondaryStyle: boolean) => {
    const p = (e.spent / total) * 100;
    const color = secondaryStyle ? "var(--muted)" : (e.color ?? FALLBACK[i % FALLBACK.length]);
    const id = e.category_id;
    const open = openId != null && openId === id;
    return (
      <div key={`${id}-${i}`}>
        <HoverTip content={
          <><div className="tip-lbl">{e.category_name ?? noCat}</div>
          <div className="r"><span className="d" style={{ background: color }} />{formatMinor(e.spent, { decimals: false })} {sign}</div>
          <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{p.toFixed(0)}% · {e.n} {t("stats.txCountShort")} · {t("stats.avgShort")} {formatMinor(Math.round(e.spent / Math.max(1, e.n)), { decimals: false })} {sign}</div></>
        }>
          <button type="button" className={`catbar catbar-btn ${open ? "open" : ""}`}
            onClick={() => id != null && setOpenId(open ? null : id)}>
            <span className="cb-name"><span className="d" style={{ background: color }} />{e.category_name ?? noCat}</span>
            <span className="cb-track"><span className="cb-fill" style={{ width: `${Math.min(p, 100)}%`, background: color }} /></span>
            {id != null && spark?.categories[String(id)] && <Sparkline values={spark.categories[String(id)]} color={color} />}
            <span className="cb-val">{formatMinor(e.spent, { decimals: false })} {sign}</span>
            <span className="cb-pct">{p.toFixed(0)}%</span>
          </button>
        </HoverTip>
        {open && id != null && <CatDrill category={id} from={from} to={to} currency={currency} sign={sign} />}
      </div>
    );
  };

  return (
    <div className="card flush"><div className="catbars">
      {primary.slice(0, 9).map((e, i) => bar(e, i, false))}
      {secondary.length > 0 && (
        <div className="cat-secondary">
          <SecondaryHeader />
          {secondary.map((e, i) => bar(e, i, true))}
        </div>
      )}
    </div></div>
  );
}

// Заголовок вторинного блоку: кнопка AI-розмітки реальної категорії переказів/знять (§F2 крок 2).
function SecondaryHeader() {
  const t = useT();
  const { data: status } = useGetTransfersStatusQuery();
  const [showReview, setShowReview] = useState(false);
  const pending = status?.pending ?? 0;

  return (
    <>
      <div className="cat-ai-callout">
        <div className="cat-ai-body">
          <div className="cat-ai-title"><Icon name="spark" size={15} /> {t("stats.secondary.title")}</div>
          <div className="cat-ai-sub">
            {pending > 0
              ? t("stats.secondary.pending", { count: pending })
              : t("stats.secondary.done")}
          </div>
        </div>
        <button type="button" className="btn primary cat-ai-btn" onClick={() => setShowReview(true)}>
          {pending > 0 && <Icon name="spark" size={15} />}
          {pending > 0 ? t("stats.secondary.reviewBtn") : t("stats.secondary.reviewBtnDone")}
        </button>
      </div>
      {showReview && <TransferReviewModal onClose={() => setShowReview(false)} />}
    </>
  );
}

function CatDrill({ category, from, to, currency, sign }: { category: number; from: number; to: number; currency: Cur; sign: string }) {
  const t = useT();
  const { data, isFetching } = useGetCategoryDrillQuery({ category, from, to, currency });
  if (isFetching) return <div className="cat-drill"><SkeletonRows n={4} /></div>;
  if (!data) return null;
  // Коли в категорії немає власних підкатегорій, сервер повертає один "підкатегорійний"
  // рядок = сама категорія — дублює заголовок бару один-в-один. Ховаємо цей шум.
  const subs = data.subs.length === 1 && data.subs[0].category_id === category ? [] : data.subs;
  const subMax = Math.max(...subs.map((s) => s.spent), 1);
  const mMax = Math.max(...data.merchants.map((m) => m.spent), 1);
  const txs = data.transactions ?? [];
  const txTotal = txs.reduce((a, t) => a + Math.abs(t.amount), 0);
  const hasSubs = subs.length > 0;
  const hasMerch = data.merchants.length > 0;
  return (
    <div className="cat-drill">
      {(hasSubs || hasMerch) && (
        <div className={`cat-drill-grid ${hasSubs && hasMerch ? "" : "single"}`}>
          {hasSubs && (
            <div className="cat-drill-panel">
              <div className="cat-drill-panel-h">{t("stats.catdrill.subs")}</div>
              {subs.map((s, i) => (
                <div key={i} className="drill-row">
                  <span className="drill-name"><span className="d" style={{ background: s.color ?? "var(--muted)" }} />{s.name}</span>
                  <span className="drill-track"><span style={{ width: `${(s.spent / subMax) * 100}%`, background: s.color ?? "var(--muted)" }} /></span>
                  <span className="drill-val">{formatMinor(s.spent, { decimals: false })} {sign}</span>
                </div>
              ))}
            </div>
          )}
          {hasMerch && (
            <div className="cat-drill-panel">
              <div className="cat-drill-panel-h">{t("stats.catdrill.topMerch")}</div>
              {data.merchants.slice(0, 6).map((m, i) => (
                <div key={i} className="drill-row">
                  <span className="drill-name">{m.merchant}</span>
                  <span className="drill-track"><span style={{ width: `${(m.spent / mMax) * 100}%`, background: "var(--accent)" }} /></span>
                  <span className="drill-val">{formatMinor(m.spent, { decimals: false })} {sign}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* §R2-ST5(в): самі операції зрізу з переходом на транзакцію. */}
      {txs.length > 0 && (
        <div className="cat-drill-block cat-drill-txs">
          <div className="label">{t("stats.catdrill.txs", { count: txs.length, plus: txs.length >= 60 ? "+" : "", total: formatMinor(txTotal, { decimals: false }), sign })}</div>
          <DrillTxList txs={txs} />
        </div>
      )}
      {!hasSubs && !hasMerch && !txs.length && <span className="muted" style={{ fontSize: 12.5 }}>{t("stats.drill.noMerch")}</span>}
    </div>
  );
}

// §R2-ST5(в): спільний список операцій зрізу з переходом на /tx/:id.
// §1: дрил-операції = стандартний рядок транзакції (спільний TxItem), лише компактніший.
// §1: підзаголовок «що саме рахується» — щоб цифра зрізу була прозорою (канон stats.ts).
const DRILL_NOTE: Record<"expense" | "income", "stats.drill.drillNoteExpense" | "stats.drill.drillNoteIncome"> = {
  expense: "stats.drill.drillNoteExpense",
  income: "stats.drill.drillNoteIncome",
};
function DrillTxList({ txs, kind = "expense" }: { txs: DrillTx[]; kind?: "expense" | "income" }) {
  const t = useT();
  return (
    <>
      <div className="drill-note muted">{t(DRILL_NOTE[kind])}</div>
      <div className="ledger rows drill-txs">
        {txs.map((t) => (
          <TxItem key={t.id} t={t} compact />
        ))}
      </div>
    </>
  );
}

// §R2-ST3+ST5(б) / §P3: Топ мерчантів — рядки-лінки на сторінку мерчанта (уся історія,
// тренд, середній чек, частка в категорії). Раніше клік розкривав інлайн-дрил операцій —
// сторінка мерчанта багатша, тож ведемо туди.
function MerchantsBlock({ data, sign, merchMax }: {
  data: Overview; sign: string; merchMax: number;
}) {
  const t = useT();
  const { data: spark } = useGetSparkQuery();
  return (
    <section>
      <div className="section-head"><h2>{t("stats.merchants.title")}</h2><InfoTip>{t("stats.merchants.tip")}</InfoTip><span className="label">{t("stats.byCategory.click")}</span></div>
      {data.byMerchant.length ? (
        <div className="card flush"><div className="mrows">
          {data.byMerchant.slice(0, 7).map((m, i) => (
            <Link key={i} to={`/merchant/${encodeURIComponent(m.merchant)}`} className="mrow mrow-link">
              <MerchantLogo merchant={m.merchant} color="var(--accent)" fallbackLabel={m.merchant} />
              <div className="m-body">
                <div className="m-name">{m.merchant}</div>
                <div className="m-track"><div className="m-fill" style={{ width: `${(m.spent / merchMax) * 100}%` }} /></div>
              </div>
              {spark?.merchants[m.merchant] && <Sparkline values={spark.merchants[m.merchant]} color="var(--accent)" />}
              <div style={{ textAlign: "right" }}>
                <div className="m-val">{formatMinor(m.spent, { decimals: false })} {sign}</div>
                <div className="m-sub">{t("stats.merchants.avgSub", { n: m.n, amount: formatMinor(Math.round(m.spent / m.n), { decimals: false }), sign })}</div>
              </div>
            </Link>
          ))}
        </div></div>
      ) : <div className="card empty">{t("stats.merchants.empty")}</div>}
    </section>
  );
}

// §R2-ST3+ST5(б): По групах — клік розкриває операції; лінк «відкрити групу» всередині.
function EventsBlock({ data, from, to, currency, sign }: {
  data: Overview; from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  // ROADMAP L3: this block shares a `.stats-2col` row with the merchants block, so returning
  // null left the whole right half of the tab blank — read as broken layout, not as "no groups".
  if (!data.byEvent || data.byEvent.length === 0) {
    return (
      <section>
        <div className="section-head"><h2>{t("stats.events.title")}</h2><span className="label">{t("stats.events.sub")}</span></div>
        <EmptyCard icon="folder" title={t("empty.events.title")} hint={t("empty.events.hint")}
          to="/events" action={t("empty.events.action")} />
      </section>
    );
  }
  const max = Math.max(...data.byEvent.map((e) => e.spent), 1);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.events.title")}</h2><span className="label">{t("stats.events.sub")}</span></div>
      <div className="card flush"><div className="catbars">
        {data.byEvent.map((e) => {
          const isOpen = open === e.event_id;
          return (
            <div key={e.event_id}>
              <button type="button" className={`catbar catbar-btn ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : e.event_id)}>
                <span className="cb-name"><span className="d" style={{ background: e.event_color ?? "var(--accent)" }} />{e.event_name}</span>
                <span className="cb-track"><span className="cb-fill" style={{ width: `${(e.spent / max) * 100}%`, background: e.event_color ?? "var(--accent)" }} /></span>
                <span className="cb-val">{formatMinor(e.spent, { decimals: false })} {sign}</span>
                <span className="cb-pct">{e.n}</span>
              </button>
              {isOpen && <SliceDrillPanel dim="event" value={String(e.event_id)} from={from} to={to} currency={currency} sign={sign} />}
            </div>
          );
        })}
      </div></div>
    </section>
  );
}

// §R2-ST3+ST5(б): По картках — клік розкриває операції зрізу.
function AccountsBlock({ data, from, to, currency, sign }: {
  data: Overview; from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (data.byAccount.length <= 1) return null;
  const max = Math.max(...data.byAccount.map((a) => a.spent), 1);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.accounts.title")}</h2><InfoTip>{t("stats.accounts.tip")}</InfoTip><span className="label">{t("stats.accounts.click")}</span></div>
      <div className="card flush"><div className="mrows">
        {data.byAccount.map((a, i) => {
          const key = a.account_id ?? String(i);
          const isOpen = open === key;
          const kind = cardKind(a.account_title ?? a.account_type ?? null);
          const last4 = cardLast4(a.account_title);
          return (
            <div key={key}>
              <button type="button" className={`mrow mrow-btn ${isOpen ? "open" : ""}`}
                disabled={!a.account_id} onClick={() => a.account_id && setOpen(isOpen ? null : key)}>
                <span className={`acct-badge ${kind}`}><Icon name="accounts" size={18} /></span>
                <div className="m-body">
                  <div className="m-name">
                    {cardKindLabel(kind)}
                    {last4 && <span className="acct-pan">{last4}</span>}
                  </div>
                  <div className="m-track"><div className="m-fill" style={{ width: `${(a.spent / max) * 100}%` }} /></div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="m-val">{formatMinor(a.spent, { decimals: false })} {sign}</div>
                  <div className="m-sub">{t("stats.accounts.nTx", { n: a.n })}</div>
                </div>
              </button>
              {isOpen && a.account_id && <SliceDrillPanel dim="account" value={a.account_id} from={from} to={to} currency={currency} sign={sign} />}
            </div>
          );
        })}
      </div></div>
    </section>
  );
}

// §R2-ST5(б): drill зрізу — підсумок + операції. dim=all → увесь період (клік по KPI).
function SliceDrillPanel({ dim, value, type, from, to, currency, sign, embedded }: {
  dim: "merchant" | "account" | "event" | "weekday" | "day" | "dom" | "importance" | "all"; value?: string; type?: "expense" | "income";
  from: number; to: number; currency: Cur; sign: string; embedded?: boolean;
}) {
  const t = useT();
  const { data, isFetching } = useGetSliceDrillQuery({ dim, value, type, from, to, currency, limit: dim === "all" ? 300 : 60 });
  if (isFetching) return <div className={embedded ? "" : "cat-drill"}><SkeletonRows n={5} /></div>;
  if (!data) return null;
  if (!data.transactions.length) return <div className="cat-drill"><span className="muted" style={{ fontSize: 12.5 }}>{t("stats.drill.noTx")}</span></div>;
  const cap = dim === "all" ? 300 : 60;
  return (
    <div className={embedded ? "" : "cat-drill"}>
      <div className="cat-drill-block cat-drill-txs" style={{ borderTop: "none", paddingTop: 0 }}>
        <div className="label">
          {t("stats.catdrill.txs", { count: data.n, plus: data.n >= cap ? "+" : "", total: formatMinor(data.spent, { decimals: false }), sign })}
          {dim === "event" && value != null && <Link to={`/events/${value}`} className="drill-open-link">{t("stats.drill.openEvent")}</Link>}
        </div>
        <DrillTxList txs={data.transactions} kind={type === "income" ? "income" : "expense"} />
      </div>
    </div>
  );
}

// Порівняння вибраного періоду з попереднім рівним (беклог). Обчислювана аналітика.
function deltaPct(a: number, b: number): number {
  if (b > 0) return Math.round(((a - b) / b) * 100);
  return a > 0 ? 100 : 0;
}
// `goodUp` — для рядків, де зростання ДОБРЕ (надходження). Міняє лише КОЛІР, не число:
// підмінити місцями a/b було б простіше, але тоді «+20% доходу» показалось би як «−20%».
function DeltaChip({ a, b, goodUp }: { a: number; b: number; goodUp?: boolean }) {
  const t = useT();
  if (a === b) return <span className="cmp-delta flat">0%</span>;
  // §R2-ST2(а): 0→X — не «+100%» (вводить в оману), а «новий»; X→0 — «зникло».
  const grew = a > b;
  if (b === 0 && a > 0) return <span className={`cmp-delta ${goodUp ? "down" : "up"}`}>{t("stats.compare.newLabel")}</span>;
  if (a === 0 && b > 0) return <span className={`cmp-delta ${goodUp ? "up" : "down"}`}>{t("stats.compare.goneLabel")}</span>;
  const p = deltaPct(a, b);
  // Для витрат зростання — «погано» (червоне), спад — «добре» (зелене). Для доходу — навпаки.
  const cls = grew === !goodUp ? "up" : "down";
  return <span className={`cmp-delta ${cls}`}>{p > 0 ? "+" : ""}{p}%</span>;
}

// §D: календарно-вирівняні періоди для чесного порівняння (MTD vs той самий відрізок
// попереднього періоду), а не ковзне вікно 30 днів.
// unitKey — i18n key (not resolved text), so the caller stays reactive to a live language switch.
type UnitKey = "stats.unit.week" | "stats.unit.month" | "stats.unit.quarter" | "stats.unit.year";
function calPeriods(range: RangeKey, mode: "calendar" | "rolling"): { curFrom: number; curTo: number; prevFrom: number; prevTo: number; unitKey: UnitKey } {
  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  if (mode === "rolling") {
    const days = RANGES[range].days;
    const curFrom = nowS - days * 86400;
    const unitKey = ({ week: "stats.unit.week", month: "stats.unit.month", quarter: "stats.unit.quarter", year: "stats.unit.year" } as const)[range];
    return { curFrom, curTo: nowS, prevFrom: curFrom - days * 86400, prevTo: curFrom, unitKey };
  }
  let curStart: Date, prevStart: Date, unitKey: UnitKey;
  if (range === "week") {
    const dow = (now.getDay() + 6) % 7; // Пн=0
    curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    prevStart = new Date(curStart); prevStart.setDate(prevStart.getDate() - 7);
    unitKey = "stats.unit.week";
  } else if (range === "month") {
    curStart = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    unitKey = "stats.unit.month";
  } else if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    curStart = new Date(now.getFullYear(), q * 3, 1);
    prevStart = new Date(now.getFullYear(), q * 3 - 3, 1);
    unitKey = "stats.unit.quarter";
  } else {
    curStart = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    unitKey = "stats.unit.year";
  }
  const curFrom = Math.floor(curStart.getTime() / 1000);
  const curTo = nowS;
  const elapsed = curTo - curFrom; // чесний MTD: попередній період беремо такої ж довжини
  const prevFrom = Math.floor(prevStart.getTime() / 1000);
  return { curFrom, curTo, prevFrom, prevTo: prevFrom + elapsed, unitKey };
}

function PeriodCompare({ range, mode, currency, sign }: {
  range: RangeKey; mode: "calendar" | "rolling"; currency: Cur; sign: string;
}) {
  const t = useT();
  const { curFrom, curTo, prevFrom, prevTo, unitKey } = useMemo(() => calPeriods(range, mode), [range, mode]);
  const { data, isFetching } = useGetCompareQuery({ from: curFrom, to: curTo, currency, bfrom: prevFrom, bto: prevTo });
  const dr = (a: number, b: number) => `${formatDate(a)}–${formatDate(b)}`;
  const noCat = t("common.uncategorized");
  const { rows, rest, movers } = useMemo(() => {
    if (!data) return { rows: [], rest: null as null | { a: number; b: number }, movers: { up: [], down: [] } as Movers };
    const map = new Map<number | null, { name: string; color: string | null; a: number; b: number }>();
    for (const r of data.a.byCategory) map.set(r.category_id, { name: r.category_name ?? noCat, color: r.color, a: r.spent, b: 0 });
    for (const r of data.b.byCategory) {
      const cur = map.get(r.category_id);
      if (cur) cur.b = r.spent;
      else map.set(r.category_id, { name: r.category_name ?? noCat, color: r.color, a: 0, b: r.spent });
    }
    const all = [...map.values()].sort((x, y) => y.a - x.a);
    const top = all.slice(0, 10);
    // §R2-ST2(г): решта категорій згорнута в один рядок, щоб сума рядків збігалася з тоталом.
    const tail = all.slice(10);
    const rest = tail.length
      ? tail.reduce((s, r) => ({ a: s.a + r.a, b: s.b + r.b }), { a: 0, b: 0 })
      : null;
    // §1b: топ-рухи — найбільша зміна ₴ vs минулий (поріг 50₴, щоб відсіяти шум).
    const deltas = [...map.values()].map((r) => ({ ...r, delta: r.a - r.b })).filter((r) => Math.abs(r.delta) >= 5000);
    const up = deltas.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, 3);
    const down = deltas.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, 3);
    return { rows: top, rest, movers: { up, down } as Movers };
  }, [data, noCat]);

  if (isFetching || !data) return null;
  if (!data.a.spend && !data.b.spend) return null;

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.compare.title")}</h2>
        <span className="label">{t("stats.compare.sub", { unit: t(unitKey), cur: dr(curFrom, curTo), prev: dr(prevFrom, prevTo) })}</span>
      </div>

      {(movers.up.length > 0 || movers.down.length > 0) && (
        <div className="movers">
          <div className="mv-col">
            <div className="mv-head up">{t("stats.compare.moversUp")}</div>
            {movers.up.length ? movers.up.map((r, i) => (
              <div key={i} className="mv-row">
                <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="mv-delta up">+{formatMinor(r.delta, { decimals: false })} {sign}</span>
              </div>
            )) : <div className="mv-empty">{t("stats.compare.moversEmpty")}</div>}
          </div>
          <div className="mv-col">
            <div className="mv-head down">{t("stats.compare.moversDown")}</div>
            {movers.down.length ? movers.down.map((r, i) => (
              <div key={i} className="mv-row">
                <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="mv-delta down">−{formatMinor(-r.delta, { decimals: false })} {sign}</span>
              </div>
            )) : <div className="mv-empty">{t("stats.compare.moversEmptyDown")}</div>}
          </div>
        </div>
      )}

      <div className="card cmp-card">
        <div className="cmp-head">
          <div className="cmp-col-h prev">{t("stats.compare.colPrev")}</div>
          <div className="cmp-col-h cur">{t("stats.compare.colCur")}</div>
          <div className="cmp-col-h" />
        </div>
        <div className="cmp-row cmp-total">
          <span className="cmp-name">{t("stats.compare.totalSpend")}</span>
          <span className="cmp-b">{formatMinor(data.b.spend, { decimals: false })} {sign}</span>
          <span className="cmp-a">{formatMinor(data.a.spend, { decimals: false })} {sign}</span>
          <DeltaChip a={data.a.spend} b={data.b.spend} />
        </div>
        {rows.map((r, i) => (
          <HoverTip key={i} content={
            <><div className="tip-lbl">{r.name}</div>
            <div className="r">{t("stats.compare.drillPrev", { amount: formatMinor(r.b, { decimals: false }), sign })}</div>
            <div className="r">{t("stats.compare.drillCur", { amount: formatMinor(r.a, { decimals: false }), sign })}</div></>
          }>
            <div className="cmp-row">
              <span className="cmp-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
              <span className="cmp-b">{formatMinor(r.b, { decimals: false })} {sign}</span>
              <span className="cmp-a">{formatMinor(r.a, { decimals: false })} {sign}</span>
              <DeltaChip a={r.a} b={r.b} />
            </div>
          </HoverTip>
        ))}
        {rest && (rest.a > 0 || rest.b > 0) && (
          <div className="cmp-row" title={t("stats.compare.tipOther")}>
            <span className="cmp-name"><span className="d" style={{ background: "var(--muted)" }} />{t("stats.compare.otherCats")}</span>
            <span className="cmp-b">{formatMinor(rest.b, { decimals: false })} {sign}</span>
            <span className="cmp-a">{formatMinor(rest.a, { decimals: false })} {sign}</span>
            <DeltaChip a={rest.a} b={rest.b} />
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>{t("stats.compare.excludedNote")}</p>
      </div>
    </section>
  );
}

// ---- Порівняння двох ДОВІЛЬНИХ місяців (таб «Порівняння») --------------------
// `PeriodCompare` вище прибитий до «цей період проти минулого». Тут місяці обирає
// користувач — «а що змінилось із березня?». Бекенд той самий `/analytics/compare`
// (він від початку приймає дві незалежні пари меж), тож канон і фільтри спільні.
/** Межі календарного місяця за зсувом назад від поточного. */
function monthBounds(back: number): { from: number; to: number; label: string; y: number; m: number } {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const from = Math.floor(d.getTime() / 1000);
  const to = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime() / 1000);
  return { from, to, label: `${monthLong(d.getMonth())} ${d.getFullYear()}`, y: d.getFullYear(), m: d.getMonth() };
}

function MonthCompare({ currency, sign }: { currency: Cur; sign: string }) {
  const t = useT();
  const noCat = t("common.uncategorized");
  const [aBack, setABack] = useState(0);   // A = пізніший місяць (за замовчуванням поточний)
  const [bBack, setBBack] = useState(1);   // B = база порівняння
  const options = useMemo(
    () => Array.from({ length: 24 }, (_, i) => ({ value: i, label: monthBounds(i).label })),
    [],
  );
  const A = useMemo(() => monthBounds(aBack), [aBack]);
  const B = useMemo(() => monthBounds(bBack), [bBack]);

  const { data, isFetching, error, refetch } = useGetCompareQuery({
    from: A.from, to: A.to, currency, bfrom: B.from, bto: B.to,
  });

  const { rows, rest, movers } = useMemo(() => {
    if (!data) return { rows: [] as MoverRow[], rest: null as null | { a: number; b: number }, movers: { up: [], down: [] } as Movers };
    const map = new Map<number | null, { name: string; color: string | null; a: number; b: number }>();
    for (const r of data.a.byCategory) map.set(r.category_id, { name: r.category_name ?? noCat, color: r.color, a: r.spent, b: 0 });
    for (const r of data.b.byCategory) {
      const cur = map.get(r.category_id);
      if (cur) cur.b = r.spent;
      else map.set(r.category_id, { name: r.category_name ?? noCat, color: r.color, a: 0, b: r.spent });
    }
    // Сортуємо за БІЛЬШОЮ з двох сум: категорія, що зникла, має лишитись видимою —
    // саме її зникнення часто і є відповіддю на «що змінилось».
    const all = [...map.values()].sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b));
    const tail = all.slice(12);
    return {
      rows: all.slice(0, 12) as MoverRow[],
      rest: tail.length ? tail.reduce((s, r) => ({ a: s.a + r.a, b: s.b + r.b }), { a: 0, b: 0 }) : null,
      movers: (() => {
        const deltas = [...map.values()].map((r) => ({ ...r, delta: r.a - r.b })).filter((r) => Math.abs(r.delta) >= 5000);
        return {
          up: deltas.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, 3),
          down: deltas.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, 3),
        } as Movers;
      })(),
    };
  }, [data, noCat]);

  const sameMonth = A.y === B.y && A.m === B.m;
  // ⚠️ Поточний місяць ще не завершився — порівнювати його з повним місяцем нечесно.
  // Не ховаємо дані (користувач свідомо обрав), але кажемо це прямо, як у прогнозах.
  const now = new Date();
  const partial = [A, B].filter((x) => x.y === now.getFullYear() && x.m === now.getMonth());
  const elapsedDays = now.getDate();
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.compareMonth.title")}</h2>
        <span className="label">{t("stats.compareMonth.sub")}</span>
      </div>

      <div className="mc-pickers">
        <label className="mc-pick">
          <span className="label">{t("stats.compareMonth.base")}</span>
          <Select value={bBack} options={options} onChange={(v) => setBBack(Number(v))} searchable />
        </label>
        <span className="mc-vs" aria-hidden="true">{t("stats.compareMonth.vs")}</span>
        <label className="mc-pick">
          <span className="label">{t("stats.compareMonth.cur")}</span>
          <Select value={aBack} options={options} onChange={(v) => setABack(Number(v))} searchable />
        </label>
      </div>

      <ErrorNote error={error} what={t("stats.compareMonth.error")} onRetry={refetch} />

      {sameMonth && <div className="card empty">{t("stats.compareMonth.sameMonth")}</div>}

      {!sameMonth && partial.length > 0 && (
        <p className="mc-note">
          {t("stats.compareMonth.partial", { month: monthLong(now.getMonth()), elapsed: elapsedDays, total: monthDays })}
        </p>
      )}

      {!sameMonth && data && !isFetching && !data.a.spend && !data.b.spend && (
        <div className="card empty">{t("stats.compareMonth.empty")}</div>
      )}

      {!sameMonth && data && (data.a.spend > 0 || data.b.spend > 0) && (
        <>
          {(movers.up.length > 0 || movers.down.length > 0) && (
            <div className="movers">
              <div className="mv-col">
                <div className="mv-head up">{t("stats.compare.moversUp")}</div>
                {movers.up.length ? movers.up.map((r, i) => (
                  <div key={i} className="mv-row">
                    <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                    <span className="mv-delta up">+{formatMinor(r.delta, { decimals: false })} {sign}</span>
                  </div>
                )) : <div className="mv-empty">{t("stats.compare.moversEmpty")}</div>}
              </div>
              <div className="mv-col">
                <div className="mv-head down">{t("stats.compare.moversDown")}</div>
                {movers.down.length ? movers.down.map((r, i) => (
                  <div key={i} className="mv-row">
                    <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                    <span className="mv-delta down">−{formatMinor(-r.delta, { decimals: false })} {sign}</span>
                  </div>
                )) : <div className="mv-empty">{t("stats.compare.moversEmptyDown")}</div>}
              </div>
            </div>
          )}

          <div className="card cmp-card">
            <div className="cmp-head">
              <div className="cmp-col-h prev">{B.label}</div>
              <div className="cmp-col-h cur">{A.label}</div>
              <div className="cmp-col-h" />
            </div>
            <div className="cmp-row cmp-total">
              <span className="cmp-name">{t("stats.compare.totalSpend")}</span>
              <span className="cmp-b">{formatMinor(data.b.spend, { decimals: false })} {sign}</span>
              <span className="cmp-a">{formatMinor(data.a.spend, { decimals: false })} {sign}</span>
              <DeltaChip a={data.a.spend} b={data.b.spend} />
            </div>
            <div className="cmp-row cmp-total">
              <span className="cmp-name">{t("stats.compare.totalIncome")}</span>
              <span className="cmp-b">{formatMinor(data.b.income, { decimals: false })} {sign}</span>
              <span className="cmp-a">{formatMinor(data.a.income, { decimals: false })} {sign}</span>
              <DeltaChip a={data.a.income} b={data.b.income} goodUp />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="cmp-row">
                <span className="cmp-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="cmp-b">{formatMinor(r.b, { decimals: false })} {sign}</span>
                <span className="cmp-a">{formatMinor(r.a, { decimals: false })} {sign}</span>
                <DeltaChip a={r.a} b={r.b} />
              </div>
            ))}
            {rest && (rest.a > 0 || rest.b > 0) && (
              <div className="cmp-row">
                <span className="cmp-name"><span className="d" style={{ background: "var(--muted)" }} />{t("stats.compare.otherCats")}</span>
                <span className="cmp-b">{formatMinor(rest.b, { decimals: false })} {sign}</span>
                <span className="cmp-a">{formatMinor(rest.a, { decimals: false })} {sign}</span>
                <DeltaChip a={rest.a} b={rest.b} />
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              {t("stats.compare.excludedNote")}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// Глибша аналітика (обчислювана, без AI-вартості) — графіки по 2 в колонку + опис (§F1).
// Працює, коли бакет = день (тиждень/місяць): з денних сум виводимо патерни витрат.
function DeeperAnalytics({ series, sign, from, to, currency }: {
  series: Overview["series"]; sign: string; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [openWd, setOpenWd] = useState<number | null>(null);
  const [openPriciest, setOpenPriciest] = useState(false);
  const [openDom, setOpenDom] = useState<number | null>(null);
  const daily = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  if (daily.length < 4) return null;

  const byWeekday = new Array(7).fill(0) as number[];
  let weekdaySum = 0, weekendSum = 0;
  for (const s of daily) {
    const d = new Date(s.bucket + "T00:00:00");
    const wd = d.getDay();
    byWeekday[wd] += s.spend;
    if (wd === 0 || wd === 6) weekendSum += s.spend; else weekdaySum += s.spend;
  }
  const wdMax = Math.max(...byWeekday, 1);
  const topWd = byWeekday.indexOf(Math.max(...byWeekday));
  const total = weekdaySum + weekendSum || 1;
  const weekendPct = Math.round((weekendSum / total) * 100);

  // §1b: найдорожчий день + скільки днів без витрат за період.
  const priciest = daily.reduce<Overview["series"][number] | null>((m, s) => (s.spend > (m?.spend ?? -1) ? s : m), null);
  const totalDays = Math.max(1, Math.round((to - from) / 86400));
  const noSpendDays = Math.max(0, totalDays - daily.filter((s) => s.spend > 0).length);

  // §1: heat-map — сума витрат за числом місяця (1..31), щоб видно було «дорогі» дати (зарплата, оренда).
  const byDom = new Array(31).fill(0) as number[];
  for (const s of daily) { const dom = Number(s.bucket.split("-")[2]); if (dom >= 1 && dom <= 31) byDom[dom - 1] += s.spend; }
  const domMax = Math.max(...byDom, 1);
  const hasDom = byDom.some((v) => v > 0);

  return (
    <section>
      <div className="section-head"><h2>{t("stats.patterns.title")}</h2><span className="label">{t("stats.patterns.sub")}</span></div>
      <div className="stat-facts" style={{ marginBottom: 10 }}>
        <button type="button" className={`fact fact-click ${openPriciest ? "open" : ""}`}
          disabled={!priciest || !(priciest.spend > 0)}
          onClick={() => setOpenPriciest((o) => !o)}>
          <FactLabel info={<>{t("stats.patterns.priciestInfo")}</>}>{t("stats.patterns.priciest")}</FactLabel>
          <span className="fact-val">{priciest && priciest.spend > 0 ? <>{labelFor(priciest.bucket)} · {formatMinor(priciest.spend, { decimals: false })} {sign}</> : "—"}</span>
        </button>
        <div className="fact">
          <FactLabel info={<>{t("stats.patterns.noSpendDaysInfo")}</>}>{t("stats.patterns.noSpendDays")}</FactLabel>
          <span className="fact-val">{noSpendDays} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{t("common.of")} {totalDays}</span></span>
        </div>
      </div>
      {openPriciest && priciest && priciest.spend > 0 && (
        <div className="card drill-open-card" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 6 }}>{t("stats.patterns.priciestDrill", { label: labelFor(priciest.bucket) })}</div>
          <SliceDrillPanel dim="day" value={priciest.bucket} from={from} to={to} currency={currency} sign={sign} embedded />
        </div>
      )}
      <div className="stats-2col">
        <div className="card deep-card">
          <div className="deep-title">{t("stats.patterns.byWd")} <span className="label" style={{ fontWeight: 400 }}>{t("stats.patterns.byWdSub")}</span></div>
          <div className="wd-bars">
            {byWeekday.map((v, i) => (
              <HoverTip key={i} content={
                <><div className="tip-lbl">{weekdayLong(i)}</div>
                <div className="r">{formatMinor(v, { decimals: false })} {sign}</div>
                <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{Math.round((v / total) * 100)}{t("stats.patterns.pctOfPeriod")}</div></>
              }>
                <button type="button" className={`wd-col ${openWd === i ? "open" : ""}`}
                  onClick={() => setOpenWd(openWd === i ? null : i)}>
                  {/* scaleY замість height (layout-thrash). Мінімум 0.02 — щоб дуже малий
                      день лишався видимим: min-height трансформ не рятує. */}
                  <div className="wd-bar-wrap"><div className="wd-bar" style={{ transform: `scaleY(${Math.max(0.02, v / wdMax)})`, background: i === topWd || i === openWd ? "var(--accent)" : "var(--line-strong)" }} /></div>
                  <span className="wd-lbl">{weekdayShort(i)}</span>
                </button>
              </HoverTip>
            ))}
          </div>
          <p className="deep-desc">{t("stats.patterns.topWdDesc", { weekday: weekdayLong(topWd), amount: formatMinor(byWeekday[topWd], { decimals: false }), sign })}</p>
          {openWd != null && (
            <div className="wd-drill">
              <div className="label" style={{ marginBottom: 2 }}>{t("stats.patterns.wdDrill", { weekday: weekdayLong(openWd) })}</div>
              <SliceDrillPanel dim="weekday" value={String(openWd)} from={from} to={to} currency={currency} sign={sign} />
            </div>
          )}
        </div>

        <div className="card deep-card">
          <div className="deep-title">{t("stats.patterns.weekVsWeekend")}</div>
          <div className="split-bar">
            <HoverTip content={<><div className="tip-lbl">{t("stats.patterns.weekdayLabel")}</div><div className="r">{formatMinor(weekdaySum, { decimals: false })} {sign} · {100 - weekendPct}%</div></>}>
              <div className="split-seg" style={{ width: `${100 - weekendPct}%`, background: "var(--c-cobalt, var(--accent))" }}>{100 - weekendPct}%</div>
            </HoverTip>
            <HoverTip content={<><div className="tip-lbl">{t("stats.patterns.weekendLabel")}</div><div className="r">{formatMinor(weekendSum, { decimals: false })} {sign} · {weekendPct}%</div></>}>
              <div className="split-seg alt" style={{ width: `${weekendPct}%`, background: "var(--c-teal)" }}>{weekendPct}%</div>
            </HoverTip>
          </div>
          <div className="split-legend">
            <span><span className="d" style={{ background: "var(--accent)" }} />{t("stats.patterns.weekdayNote", { amount: formatMinor(weekdaySum, { decimals: false }), sign })}</span>
            <span><span className="d" style={{ background: "var(--c-teal)" }} />{t("stats.patterns.weekendNote", { amount: formatMinor(weekendSum, { decimals: false }), sign })}</span>
          </div>
          <p className="deep-desc">{weekendPct >= 40 ? t("stats.patterns.weekendHigh") : t("stats.patterns.weekendLow")}</p>
        </div>
      </div>

      {hasDom && (
        <div className="card deep-card" style={{ marginTop: 14 }}>
          <div className="deep-title">{t("stats.patterns.byDom")} <span className="label" style={{ fontWeight: 400 }}>{t("stats.patterns.byDomSub")}</span></div>
          <div className="dom-heat">
            {byDom.map((v, i) => {
              const intensity = v > 0 ? 0.15 + 0.85 * (v / domMax) : 0;
              const dom = i + 1;
              return (
                <HoverTip key={i} content={<><div className="tip-lbl">{t("stats.patterns.domTip", { dom })}</div><div className="r">{formatMinor(v, { decimals: false })} {sign}</div></>}>
                  <button type="button" className={`dom-cell ${openDom === dom ? "open" : ""}`} disabled={!(v > 0)}
                    onClick={() => setOpenDom((o) => (o === dom ? null : dom))}
                    style={{ background: v > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)` : "var(--surface-2)" }}>
                    <span className="dom-num" style={{ color: intensity > 0.55 ? "#fff" : "var(--muted)" }}>{dom}</span>
                  </button>
                </HoverTip>
              );
            })}
          </div>
          {openDom != null && (
            <div className="drill-open-card" style={{ marginTop: 12, padding: 0 }}>
              <div className="label" style={{ marginBottom: 6 }}>{t("stats.patterns.domDrill", { dom: openDom })}</div>
              <SliceDrillPanel dim="dom" value={String(openDom)} from={from} to={to} currency={currency} sign={sign} embedded />
            </div>
          )}
          <p className="deep-desc">{t("stats.patterns.domDesc")}</p>
        </div>
      )}
    </section>
  );
}

// §6: смуга частки витрат за вагомістю (обов'язкові / бажані / необов'язкові).
// §E1/E2/E3: детерміновані патерни витрат цього місяця (без AI).
function SpendingPatterns() {
  const t = useT();
  const { data } = useGetPatternsQuery();
  if (!data) return null;
  const { recurring, anomalies, pace } = data;
  const reg = recurring.recurring.spent;
  const one = recurring.oneoff.spent;
  const tot = reg + one;
  const dfmt = dateFmt({ day: "2-digit", month: "short" });
  const hasAny = tot > 0 || anomalies.length > 0 || pace.length > 0;
  if (!hasAny) return null;

  return (
    <>
      {tot > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("stats.recurring.title")}</h2>
            <HoverTip content={<>{t("stats.recurring.tip")}</>}>
              <span className="label">{t("stats.recurring.sub")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div className="split-bar">
              {reg > 0 && <span style={{ width: `${(reg / tot) * 100}%`, background: "var(--accent)" }} title={t("stats.recurring.titleReg", { pct: Math.round((reg / tot) * 100) })} />}
              {one > 0 && <span style={{ width: `${(one / tot) * 100}%`, background: "var(--c-teal)" }} title={t("stats.recurring.titleOne", { pct: Math.round((one / tot) * 100) })} />}
            </div>
            <div className="imp-legend">
              <span className="lg"><span className="d" style={{ background: "var(--accent)" }} />{t("stats.recurring.regularLabel")} · <b>{formatMinor(reg, { decimals: false })} ₴</b> <span className="muted">({recurring.recurring.n} {t("stats.txCountShort")})</span></span>
              <span className="lg"><span className="d" style={{ background: "var(--c-teal)" }} />{t("stats.recurring.oneoffLabel")} · <b>{formatMinor(one, { decimals: false })} ₴</b> <span className="muted">({recurring.oneoff.n} {t("stats.txCountShort")})</span></span>
            </div>
            {recurring.oneoff_items.length > 0 && (
              <div className="oneoff-list">
                <div className="label" style={{ marginBottom: 6 }}>{t("stats.recurring.topOneoff")}</div>
                {recurring.oneoff_items.map((it, i) => (
                  <div key={i} className="oneoff-row">
                    <span className="oor-name">{it.merchant ?? it.category ?? t("stats.recurring.fallback")}</span>
                    <span className="oor-cat muted">{it.category ?? "—"}</span>
                    <span className="oor-date muted">{dfmt.format(it.time * 1000)}</span>
                    <span className="oor-amt num-mono">{formatMinor(it.amount, { decimals: false })} ₴</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {anomalies.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("stats.anomaly.title")}</h2>
            <HoverTip content={<>{t("stats.anomaly.tip")}</>}>
              <span className="label">{t("common.whatIsThis")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 8 }}>
            {anomalies.map((a, i) => (
              <div key={i} className="anomaly warn">
                <span className="an-dot" style={{ background: a.color ?? undefined }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{a.category}</b>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {t("stats.anomaly.desc", { projected: formatMinor(a.projected, { decimals: false }), usual: formatMinor(a.usual, { decimals: false }) })}
                  </div>
                </div>
                {a.pct != null && <span className="cmp-delta up">+{a.pct - 100}%</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {pace.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("stats.pace.title")}</h2>
            <HoverTip content={<>{t("stats.pace.tip")}</>}>
              <span className="label">{t("stats.pace.sub")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 8 }}>
            {pace.map((p, i) => (
              <div key={i} className="pace-row">
                <span className="pace-name">
                  <span className="d" style={{ background: p.color ?? "var(--accent)" }} />{p.category}
                  {(p.mostly_oneoff || p.lumpy) && <span className="pace-tag" title={t("stats.pace.lumpyTitle")}>{t("stats.pace.lumpyTag")}</span>}
                </span>
                <span className="pace-nums num-mono">
                  {formatMinor(p.spent, { decimals: false })} → <b>≈{formatMinor(p.projected, { decimals: false })}</b> ₴
                  <span className="muted"> / {formatMinor(p.usual, { decimals: false })}</span>
                </span>
                {p.pct != null && (
                  <span className={`cmp-delta ${p.pct > 115 ? "up" : p.pct < 85 ? "down" : "flat"}`}>{p.pct}%</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// Середній чек по категоріях (spent ÷ n). Відповідає на «де окремі покупки найдорожчі» —
// категорія з малою сумою, але великим чеком (напр. техніка) інакше губиться в загальному топі.
// Клієнтський розрахунок із byCategory (канонічні suми/кількості з overview).
function AvgCheckByCategory({ rows, sign }: { rows: Overview["byCategory"]; sign: string }) {
  const t = useT();
  const noCat = t("common.uncategorized");
  const items = rows
    .filter((r) => !isSecondaryCat(r.category_name) && r.n > 0 && r.spent > 0)
    .map((r, i) => ({ name: r.category_name ?? noCat, color: r.color ?? FALLBACK[i % FALLBACK.length], avg: Math.round(r.spent / r.n), n: r.n }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 8);
  if (items.length < 2) return null;
  const max = Math.max(...items.map((x) => x.avg), 1);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.avgCheck.title")}</h2><InfoTip>{t("stats.avgCheck.tip")}</InfoTip><span className="label">{t("stats.avgCheck.sub")}</span></div>
      <div className="card flush"><div className="catbars">
        {items.map((it, i) => (
          <div key={i} className="catbar">
            <span className="cb-name"><span className="d" style={{ background: it.color }} />{it.name}</span>
            <span className="cb-track"><span className="cb-fill" style={{ width: `${(it.avg / max) * 100}%`, background: it.color }} /></span>
            <span className="cb-val">{formatMinor(it.avg, { decimals: false })} {sign}</span>
            <span className="cb-pct">{t("stats.avgCheck.nTx", { n: it.n })}</span>
          </div>
        ))}
      </div></div>
    </section>
  );
}

// Топ-5 найдорожчих днів періоду (з денних бакетів series). Клік — операції того дня.
// Розширює одиничний «найдорожчий день» у Глибшій аналітиці до рейтингу.
function TopSpendDays({ series, sign, from, to, currency }: {
  series: Overview["series"]; sign: string; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const daily = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket) && s.spend > 0);
  if (daily.length < 3) return null;
  const top = [...daily].sort((a, b) => b.spend - a.spend).slice(0, 5);
  const max = top[0]?.spend || 1;
  const dfmt = dateFmt({ weekday: "short", day: "numeric", month: "short" });
  return (
    <section>
      <div className="section-head"><h2>{t("stats.topDays.title")}</h2><span className="label">{t("stats.topDays.sub")}</span></div>
      <div className="card flush"><div className="catbars">
        {top.map((s) => {
          const isOpen = open === s.bucket;
          const d = new Date(s.bucket + "T00:00:00");
          return (
            <div key={s.bucket}>
              <button type="button" className={`catbar catbar-btn ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : s.bucket)}>
                <span className="cb-name">{dfmt.format(d)}</span>
                <span className="cb-track"><span className="cb-fill" style={{ width: `${(s.spend / max) * 100}%`, background: "var(--accent)" }} /></span>
                <span className="cb-val">{formatMinor(s.spend, { decimals: false })} {sign}</span>
              </button>
              {isOpen && <SliceDrillPanel dim="day" value={s.bucket} from={from} to={to} currency={currency} sign={sign} />}
            </div>
          );
        })}
      </div></div>
    </section>
  );
}

function ImportanceBreakdown({ data, sign, from, to, currency }: { data: Overview; sign: string; from: number; to: number; currency: Cur }) {
  const t = useT();
  const rows = data.byImportance ?? [];
  const total = rows.reduce((s, r) => s + Math.abs(r.spent), 0);
  const [open, setOpen] = useState<Importance | null>(null);
  if (!total) return null;
  const byLevel = (lv: string) => Math.abs(rows.find((r) => r.importance === lv)?.spent ?? 0);
  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.importance.title")}</h2>
        <HoverTip content={<>{t("stats.importance.tip")}</>}>
          <span className="label">{t("stats.importance.sub")}</span>
        </HoverTip>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <div className="imp-bar imp-bar-lg">
          {IMPORTANCE_LEVELS.map((lv) => {
            const v = byLevel(lv);
            if (!v) return null;
            const pct = Math.round((v / total) * 100);
            return (
              <span key={lv} style={{ width: `${(v / total) * 100}%`, background: IMPORTANCE_META[lv].color }} title={`${t(IMPORTANCE_META[lv].labelKey)}: ${pct}%`}>
                {pct >= 8 && <span className="imp-seg-lbl">{pct}%</span>}
              </span>
            );
          })}
        </div>
        <div className="imp-cards">
          {IMPORTANCE_LEVELS.map((lv) => {
            const v = byLevel(lv);
            const pct = Math.round((v / total) * 100);
            return (
              <button type="button" key={lv} className={`imp-card fact-click ${open === lv ? "open" : ""}`}
                disabled={!v} onClick={() => setOpen((o) => (o === lv ? null : lv))}>
                <span className="imp-card-top"><span className="d" style={{ background: IMPORTANCE_META[lv].color }} />{t(IMPORTANCE_META[lv].labelKey)} ›</span>
                <span className="imp-card-amt num-hero">{formatMinor(v, { decimals: false })} {sign}</span>
                <span className="imp-card-pct muted">{pct}{t("stats.importance.ofSpend")}</span>
              </button>
            );
          })}
        </div>
        {open && byLevel(open) > 0 && (
          <div className="drill-open-card" style={{ marginTop: 12 }}>
            <div className="label" style={{ marginBottom: 6 }}>{t("stats.importance.drill", { label: t(IMPORTANCE_META[open].labelKey) })}</div>
            <SliceDrillPanel dim="importance" value={open} from={from} to={to} currency={currency} sign={sign} embedded />
          </div>
        )}
      </div>
    </section>
  );
}

// Заголовок дрібного факту (stat-facts) з опційним поясненням.
function FactLabel({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <span className="fact-label-row">
      <span className="fact-label">{children}</span>
      {info && <InfoTip>{info}</InfoTip>}
    </span>
  );
}

// Вміст KPI-плитки (без обгортки card — обгортає викликач: card або button).
function StatKpiInner({ title, minor, prev, sign, goodWhenUp, tone, info }: {
  title: string; minor: number; prev?: number; sign: string; goodWhenUp?: boolean; tone?: "pos" | "neg"; info?: ReactNode;
}) {
  const t = useT();
  let deltaPct: number | null = null;
  if (prev != null && prev > 0) deltaPct = ((minor - prev) / prev) * 100;
  const up = (deltaPct ?? 0) >= 0;
  const good = up === !!goodWhenUp;
  return (
    <>
      <div className="kpi-head-row">
        <span className="kpi-title">{title}</span>
        {info && <span className="kpi-info"><InfoTip>{info}</InfoTip></span>}
      </div>
      <div className={`kpi-num num-hero ${tone ?? ""}`}>
        {formatMinor(minor, { decimals: false })}<span className="cur">{sign}</span>
      </div>
      {deltaPct !== null ? (
        <div className="kpi-foot">
          <span className={`delta ${good ? "up" : "down"}`}>{up ? "↑" : "↓"} {Math.abs(deltaPct).toFixed(1)}%</span>
          <span>{t("stats.kpi.vsPrev")}</span>
        </div>
      ) : (
        <div className="kpi-foot"><span>{t("stats.kpi.forPeriod")}</span></div>
      )}
    </>
  );
}
