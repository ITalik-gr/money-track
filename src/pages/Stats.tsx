import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useGetCurrenciesQuery, useGetOverviewQuery, useGetCategoryDrillQuery, useGetSliceDrillQuery, useGetTransfersStatusQuery, useGetCompareQuery, useGetPatternsQuery, useGetPeriodModeQuery, useSetPeriodModeMutation } from "../store/api.ts";
import type { Overview, DrillTx } from "../store/api.ts";
import { TransferReviewModal } from "../components/TransferReviewModal.tsx";
import { currencySign, formatMinor, formatDate } from "../lib/format.ts";
import { CashflowChart } from "../components/CashflowChart.tsx";
import { CumulativeChart } from "../components/CumulativeChart.tsx";
import { IncomeBreakdown } from "../components/IncomeBreakdown.tsx";
import { ReceiptItems } from "../components/ReceiptItems.tsx";
import { PriceDrift } from "../components/PriceDrift.tsx";
import { AiInsightCard } from "../components/AiInsightCard.tsx";
import { MerchantLogo } from "../components/MerchantLogo.tsx";
import { TxItem } from "../components/TxItem.tsx";
import { HoverTip } from "../components/HoverTip.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { Select } from "../components/Select.tsx";
import { Icon } from "../components/Icon.tsx";
import { cardKind, cardKindLabel, cardLast4 } from "../lib/merchant.ts";
import { IMPORTANCE_LEVELS, IMPORTANCE_META, type Importance } from "../lib/importance.ts";

const RANGES = {
  week: { label: "Тиждень", days: 7 },
  month: { label: "Місяць", days: 30 },
  quarter: { label: "3 місяці", days: 90 },
  year: { label: "Рік", days: 365 },
} as const;
type RangeKey = keyof typeof RANGES;

const TABS = {
  overview: "Огляд",
  categories: "Категорії",
  trends: "Тренди",
  merchants: "Мерчанти",
} as const;
type TabKey = keyof typeof TABS;

const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
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
  if (/^\d{4}-W\d+$/.test(bucket)) return "Т" + bucket.split("-W")[1];
  if (/^\d{4}-\d{2}$/.test(bucket)) return MONTHS[Number(bucket.split("-")[1]) - 1] ?? bucket;
  return bucket;
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
  const dm = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "numeric" });
  for (let i = 1; i <= remaining; i++) {
    d.setDate(d.getDate() + 1);
    rows.push({ label: dm.format(d).replace(/\s/g, ""), cum: null, proj: Math.round(lastCum + slope * i) });
  }
  return rows;
}

export function Stats() {
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

  const { data, isFetching } = useGetOverviewQuery({ preset: range, currency });
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
    ? { week: "цей тиждень", month: "цей місяць", quarter: "цей квартал", year: "цей рік" }[range]
    : `останні ${RANGES[range].days} дн`;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Статистика</div>
          <div className="sub">Куди йдуть і звідки надходять гроші · {periodNote}</div>
        </div>
        <div className="page-head-actions">
          <div className="seg">
            {(Object.keys(RANGES) as RangeKey[]).map((k) => (
              <button key={k} className={`seg-btn ${range === k ? "active" : ""}`} onClick={() => setParam("range", k)}>
                {RANGES[k].label}
              </button>
            ))}
          </div>
          <button className="pill-toggle" title="Календарний = природний цикл (цей тиждень/місяць). Ковзний = останні N днів."
            onClick={() => setPeriodMode(mode === "calendar" ? "rolling" : "calendar")}>
            <Icon name={mode === "calendar" ? "calendar" : "repeat"} size={14} />
            {mode === "calendar" ? "Календарний" : "Ковзний"}
          </button>
          {currencies && currencies.length > 1 && (
            <Select
              className="ph-cur-sel"
              value={currency ?? "all"}
              options={[{ value: "all", label: "₴ звед." }, ...currencies.map((c) => ({ value: c, label: currencySign(c) }))]}
              onChange={(v) => setCurrency(v === "all" ? null : Number(v))}
            />
          )}
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as TabKey[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setParam("tab", k)}>
            {TABS[k]}
          </button>
        ))}
      </div>

      <div className="stack" style={{ gap: 18 }}>
        {!data && isFetching && <div className="empty">Рахуємо…</div>}

        {data && (
          <>
            {tab === "overview" && (
              <>
                <AiInsightCard days={days} />
                <ClickableKpis data={data} sign={sign} net={net} avgDay={avgDay} from={from} to={to} currency={currency} />
                <div className="stat-facts">
                  <div className="fact">
                    <FactLabel>Операцій</FactLabel>
                    <span className="fact-val">{data.summary.n}</span>
                  </div>
                  <div className="fact">
                    <FactLabel info={<>Скільки з надходжень лишається після витрат: (надходження − витрати) ÷ надходження. Від'ємне значення — витратив більше, ніж отримав.</>}>Норма заощаджень</FactLabel>
                    <span className={`fact-val ${savingsRate != null ? (savingsRate >= 0 ? "pos" : "neg") : ""}`}>
                      {savingsRate != null ? `${savingsRate}%` : "—"}
                    </span>
                  </div>
                  <div className="fact">
                    <FactLabel info={<>Категорія з найбільшою сумою витрат за період (з урахуванням підкатегорій).</>}>Найбільша категорія</FactLabel>
                    <span className="fact-val fact-cat">
                      {topCat ? (<><span className="d" style={{ background: topCat.color ?? "var(--accent)" }} />{topCat.category_name ?? "—"} · {formatMinor(topCat.spent, { decimals: false })} {sign}</>) : "—"}
                    </span>
                  </div>
                  <div className="fact">
                    <FactLabel info={<>Середня сума однієї витратної операції: витрати ÷ кількість операцій.</>}>Середній чек</FactLabel>
                    <span className="fact-val">{avgCheck ? `${formatMinor(avgCheck, { decimals: false })} ${sign}` : "—"}</span>
                  </div>
                  {projected != null && (
                    <div className="fact">
                      <FactLabel info={<>Оцінка витрат на кінець періоду за поточним темпом: середні витрати/день × кількість днів у періоді. Показується, поки період ще не завершився.</>}>Прогноз на кінець періоду</FactLabel>
                      <span className="fact-val">≈{formatMinor(projected, { decimals: false })} {sign}</span>
                    </div>
                  )}
                </div>
                <ImportanceBreakdown data={data} sign={sign} from={from} to={to} currency={currency} />
                <SpendingPatterns />
                <section>
                  <div className="section-head"><h2>Грошовий потік</h2><span className="label">витрати й надходження</span></div>
                  <div className="card cashflow">
                    <div className="legend" style={{ justifyContent: "flex-end", padding: "2px 4px 8px" }}>
                      <span><span className="d" style={{ background: "var(--chart-income)" }} />Надходження</span>
                      <span><span className="d" style={{ background: "var(--chart-expense)" }} />Витрати</span>
                    </div>
                    <CashflowChart rows={rows} height={240} />
                  </div>
                </section>
              </>
            )}

            {tab === "categories" && (
              <>
                <section>
                  <div className="section-head"><h2>Витрати по категоріях</h2><InfoTip>Підкатегорії згорнуто в батьківську. Готівка й зняття зараховані за реальною категорією; перекази між своїми виключені. Клік — деталі категорії.</InfoTip><span className="label">клік — деталі</span></div>
                  {data.byCategory.length ? (
                    <CategoryBreakdown rows={data.byCategory} from={from} to={to} currency={currency} sign={sign} />
                  ) : <div className="card empty">Немає витрат за період.</div>}
                </section>
                <ReceiptItems from={from} to={to} sign={sign} />
                <PriceDrift />
                <PeriodCompare range={range} mode={mode} currency={currency} sign={sign} />
              </>
            )}

            {tab === "trends" && (
              <>
                <section>
                  <div className="section-head"><h2>Динаміка</h2><span className="label">по днях/тижнях періоду</span></div>
                  <div className="card cashflow"><CashflowChart rows={rows} height={240} /></div>
                </section>
                <section>
                  <div className="section-head">
                    <h2>Кумулятивний потік</h2>
                    <HoverTip content={<>Накопичена різниця <b>надходження − витрати</b> від початку періоду. Лінія вгору — відкладаєш; вниз — проїдаєш. Нуль = вийшов у баланс. <b>Пунктир</b> — прогноз до кінця періоду за поточним темпом.</>}>
                      <span className="label">що це?</span>
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
  const [open, setOpen] = useState<"expense" | "income" | null>(null);
  return (
    <>
      <div className="stat-kpis">
        <button type="button" className={`card kpi-tile kpi-click ${open === "expense" ? "open" : ""}`} onClick={() => setOpen(open === "expense" ? null : "expense")}>
          <StatKpiInner title="Витрати ›" minor={data.summary.spend} prev={data.prev.spend} sign={sign} goodWhenUp={false}
            info={<>Сума всіх витрат за період: без переказів між своїми рахунками і без зняття готівки (готівка рахується за реальною категорією). Операції в обробці — теж тут.</>} />
        </button>
        <button type="button" className={`card kpi-tile kpi-click ${open === "income" ? "open" : ""}`} onClick={() => setOpen(open === "income" ? null : "income")}>
          <StatKpiInner title="Надходження ›" minor={data.summary.income} prev={data.prev.income} sign={sign} goodWhenUp
            info={<>Сума всіх надходжень за період, без переказів між своїми рахунками.</>} />
        </button>
        <div className="card kpi-tile">
          <StatKpiInner title="Чистий потік" minor={net} sign={sign} tone={net >= 0 ? "pos" : "neg"}
            info={<>Надходження мінус витрати за період. Від'ємне значення — витратив більше, ніж отримав.</>} />
        </div>
        <div className="card kpi-tile">
          <StatKpiInner title="Середньо/день" minor={avgDay} sign={sign}
            info={<>Середні витрати за один день періоду: витрати, поділені на кількість днів у періоді.</>} />
        </div>
      </div>
      {open && (
        <div className="card drill-open-card">
          <div className="label" style={{ marginBottom: 6 }}>
            {open === "expense" ? "Усі витрати, що рахуються" : "Усі надходження"} за період
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
  const [openId, setOpenId] = useState<number | null>(null);
  const primary = rows.filter((r) => !isSecondaryCat(r.category_name));
  const secondary = rows.filter((r) => isSecondaryCat(r.category_name));
  const total = primary.reduce((a, c) => a + c.spent, 0) || 1;

  const bar = (e: Overview["byCategory"][number], i: number, secondaryStyle: boolean) => {
    const p = (e.spent / total) * 100;
    const color = secondaryStyle ? "var(--muted)" : (e.color ?? FALLBACK[i % FALLBACK.length]);
    const id = e.category_id;
    const open = openId != null && openId === id;
    return (
      <div key={`${id}-${i}`}>
        <HoverTip content={
          <><div className="tip-lbl">{e.category_name ?? "без категорії"}</div>
          <div className="r"><span className="d" style={{ background: color }} />{formatMinor(e.spent, { decimals: false })} {sign}</div>
          <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{p.toFixed(0)}% · {e.n} оп. · сер. {formatMinor(Math.round(e.spent / Math.max(1, e.n)), { decimals: false })} {sign}</div></>
        }>
          <button type="button" className={`catbar catbar-btn ${open ? "open" : ""}`}
            onClick={() => id != null && setOpenId(open ? null : id)}>
            <span className="cb-name"><span className="d" style={{ background: color }} />{e.category_name ?? "без категорії"}</span>
            <span className="cb-track"><span className="cb-fill" style={{ width: `${Math.min(p, 100)}%`, background: color }} /></span>
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
  const { data: status } = useGetTransfersStatusQuery();
  const [showReview, setShowReview] = useState(false);
  const pending = status?.pending ?? 0;

  return (
    <>
      <div className="cat-ai-callout">
        <div className="cat-ai-body">
          <div className="cat-ai-title"><Icon name="spark" size={15} /> AI визначає реальну категорію переказів</div>
          <div className="cat-ai-sub">
            {pending > 0
              ? `${pending} переказів/знять без реальної категорії. Відкрий рев'ю — AI підкаже, на що кошти пішли (зняв готівку → «Продукти»), а ти перевіриш і виправиш кожен рядок.`
              : "Усі перекази й зняття розмічено. Можна перевірити/перерозмітити ще раз у рев'ю."}
          </div>
        </div>
        <button type="button" className="btn primary cat-ai-btn" onClick={() => setShowReview(true)}>
          {pending > 0 && <Icon name="spark" size={15} />}
          {pending > 0 ? "Рев'ю переказів" : "Перевірити"}
        </button>
      </div>
      {showReview && <TransferReviewModal onClose={() => setShowReview(false)} />}
    </>
  );
}

function CatDrill({ category, from, to, currency, sign }: { category: number; from: number; to: number; currency: Cur; sign: string }) {
  const { data, isFetching } = useGetCategoryDrillQuery({ category, from, to, currency });
  if (isFetching) return <div className="cat-drill"><span className="muted" style={{ fontSize: 12.5 }}>Завантаження…</span></div>;
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
              <div className="cat-drill-panel-h">Підкатегорії</div>
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
              <div className="cat-drill-panel-h">Топ мерчантів</div>
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
          <div className="label">операції · {txs.length}{txs.length >= 60 ? "+" : ""} · {formatMinor(txTotal, { decimals: false })} {sign}</div>
          <DrillTxList txs={txs} />
        </div>
      )}
      {!hasSubs && !hasMerch && !txs.length && <span className="muted" style={{ fontSize: 12.5 }}>Немає деталізації.</span>}
    </div>
  );
}

// §R2-ST5(в): спільний список операцій зрізу з переходом на /tx/:id.
// §1: дрил-операції = стандартний рядок транзакції (спільний TxItem), лише компактніший.
// §1: підзаголовок «що саме рахується» — щоб цифра зрізу була прозорою (канон stats.ts).
const DRILL_NOTE: Record<"expense" | "income", string> = {
  expense: "Витрати: без переказів між своїми та зняття готівки; готівка — за реальною категорією; операції в обробці рахуються.",
  income: "Надходження: без переказів між своїми рахунками.",
};
function DrillTxList({ txs, kind = "expense" }: { txs: DrillTx[]; kind?: "expense" | "income" }) {
  return (
    <>
      <div className="drill-note muted">{DRILL_NOTE[kind]}</div>
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
  return (
    <section>
      <div className="section-head"><h2>Топ мерчантів</h2><InfoTip>Найбільші отримувачі витрат за період (зведено в ₴). Клік — сторінка мерчанта.</InfoTip><span className="label">клік — деталі</span></div>
      {data.byMerchant.length ? (
        <div className="card flush"><div className="mrows">
          {data.byMerchant.slice(0, 7).map((m, i) => (
            <Link key={i} to={`/merchant/${encodeURIComponent(m.merchant)}`} className="mrow mrow-link">
              <MerchantLogo merchant={m.merchant} color="var(--accent)" fallbackLabel={m.merchant} />
              <div className="m-body">
                <div className="m-name">{m.merchant}</div>
                <div className="m-track"><div className="m-fill" style={{ width: `${(m.spent / merchMax) * 100}%` }} /></div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="m-val">{formatMinor(m.spent, { decimals: false })} {sign}</div>
                <div className="m-sub">{m.n} оп. · сер. {formatMinor(Math.round(m.spent / m.n), { decimals: false })} {sign}</div>
              </div>
            </Link>
          ))}
        </div></div>
      ) : <div className="card empty">Немає мерчантів за період.</div>}
    </section>
  );
}

// §R2-ST3+ST5(б): По групах — клік розкриває операції; лінк «відкрити групу» всередині.
function EventsBlock({ data, from, to, currency, sign }: {
  data: Overview; from: number; to: number; currency: Cur; sign: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!data.byEvent || data.byEvent.length === 0) return null;
  const max = Math.max(...data.byEvent.map((e) => e.spent), 1);
  return (
    <section>
      <div className="section-head"><h2>По групах</h2><span className="label">подорожі, проєкти, події</span></div>
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
  const [open, setOpen] = useState<string | null>(null);
  if (data.byAccount.length <= 1) return null;
  const max = Math.max(...data.byAccount.map((a) => a.spent), 1);
  return (
    <section>
      <div className="section-head"><h2>По картках</h2><InfoTip>Витрати згруповані за рахунком списання. Кредитний ліміт не зливається з власними коштами.</InfoTip><span className="label">клік — операції</span></div>
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
                  <div className="m-sub">{a.n} оп.</div>
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
  const { data, isFetching } = useGetSliceDrillQuery({ dim, value, type, from, to, currency, limit: dim === "all" ? 300 : 60 });
  if (isFetching) return <div className="cat-drill"><span className="muted" style={{ fontSize: 12.5 }}>Завантаження…</span></div>;
  if (!data) return null;
  if (!data.transactions.length) return <div className="cat-drill"><span className="muted" style={{ fontSize: 12.5 }}>Немає операцій за період.</span></div>;
  const cap = dim === "all" ? 300 : 60;
  return (
    <div className={embedded ? "" : "cat-drill"}>
      <div className="cat-drill-block cat-drill-txs" style={{ borderTop: "none", paddingTop: 0 }}>
        <div className="label">
          операції · {data.n}{data.n >= cap ? "+" : ""} · {formatMinor(data.spent, { decimals: false })} {sign}
          {dim === "event" && value != null && <Link to={`/events/${value}`} className="drill-open-link">відкрити групу →</Link>}
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
function DeltaChip({ a, b }: { a: number; b: number }) {
  if (a === b) return <span className="cmp-delta flat">0%</span>;
  // §R2-ST2(а): 0→X — не «+100%» (вводить в оману), а «новий»; X→0 — «зникло».
  if (b === 0 && a > 0) return <span className="cmp-delta up">новий</span>;
  if (a === 0 && b > 0) return <span className="cmp-delta down">зникло</span>;
  const p = deltaPct(a, b);
  // Для витрат зростання — «погано» (червоне), спад — «добре» (зелене).
  const cls = a > b ? "up" : "down";
  return <span className={`cmp-delta ${cls}`}>{p > 0 ? "+" : ""}{p}%</span>;
}

// §D: календарно-вирівняні періоди для чесного порівняння (MTD vs той самий відрізок
// попереднього періоду), а не ковзне вікно 30 днів.
function calPeriods(range: RangeKey, mode: "calendar" | "rolling"): { curFrom: number; curTo: number; prevFrom: number; prevTo: number; unitLabel: string } {
  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  if (mode === "rolling") {
    const days = RANGES[range].days;
    const curFrom = nowS - days * 86400;
    const unit = { week: "тиждень", month: "місяць", quarter: "квартал", year: "рік" }[range];
    return { curFrom, curTo: nowS, prevFrom: curFrom - days * 86400, prevTo: curFrom, unitLabel: unit };
  }
  let curStart: Date, prevStart: Date, unitLabel: string;
  if (range === "week") {
    const dow = (now.getDay() + 6) % 7; // Пн=0
    curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    prevStart = new Date(curStart); prevStart.setDate(prevStart.getDate() - 7);
    unitLabel = "тиждень";
  } else if (range === "month") {
    curStart = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    unitLabel = "місяць";
  } else if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    curStart = new Date(now.getFullYear(), q * 3, 1);
    prevStart = new Date(now.getFullYear(), q * 3 - 3, 1);
    unitLabel = "квартал";
  } else {
    curStart = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    unitLabel = "рік";
  }
  const curFrom = Math.floor(curStart.getTime() / 1000);
  const curTo = nowS;
  const elapsed = curTo - curFrom; // чесний MTD: попередній період беремо такої ж довжини
  const prevFrom = Math.floor(prevStart.getTime() / 1000);
  return { curFrom, curTo, prevFrom, prevTo: prevFrom + elapsed, unitLabel };
}

function PeriodCompare({ range, mode, currency, sign }: {
  range: RangeKey; mode: "calendar" | "rolling"; currency: Cur; sign: string;
}) {
  const { curFrom, curTo, prevFrom, prevTo, unitLabel } = useMemo(() => calPeriods(range, mode), [range, mode]);
  const { data, isFetching } = useGetCompareQuery({ from: curFrom, to: curTo, currency, bfrom: prevFrom, bto: prevTo });
  const dr = (a: number, b: number) => `${formatDate(a)}–${formatDate(b)}`;
  const { rows, rest, movers } = useMemo(() => {
    if (!data) return { rows: [], rest: null as null | { a: number; b: number }, movers: { up: [], down: [] } as Movers };
    const map = new Map<number | null, { name: string; color: string | null; a: number; b: number }>();
    for (const r of data.a.byCategory) map.set(r.category_id, { name: r.category_name ?? "без категорії", color: r.color, a: r.spent, b: 0 });
    for (const r of data.b.byCategory) {
      const cur = map.get(r.category_id);
      if (cur) cur.b = r.spent;
      else map.set(r.category_id, { name: r.category_name ?? "без категорії", color: r.color, a: 0, b: r.spent });
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
  }, [data]);

  if (isFetching || !data) return null;
  if (!data.a.spend && !data.b.spend) return null;

  return (
    <section>
      <div className="section-head">
        <h2>Порівняння періодів</h2>
        <span className="label">цей {unitLabel} проти минулого · {dr(curFrom, curTo)} vs {dr(prevFrom, prevTo)}</span>
      </div>

      {(movers.up.length > 0 || movers.down.length > 0) && (
        <div className="movers">
          <div className="mv-col">
            <div className="mv-head up">↑ Найбільше зросли</div>
            {movers.up.length ? movers.up.map((r, i) => (
              <div key={i} className="mv-row">
                <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="mv-delta up">+{formatMinor(r.delta, { decimals: false })} {sign}</span>
              </div>
            )) : <div className="mv-empty">без помітних зростань</div>}
          </div>
          <div className="mv-col">
            <div className="mv-head down">↓ Найбільше впали</div>
            {movers.down.length ? movers.down.map((r, i) => (
              <div key={i} className="mv-row">
                <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="mv-delta down">−{formatMinor(-r.delta, { decimals: false })} {sign}</span>
              </div>
            )) : <div className="mv-empty">без помітних падінь</div>}
          </div>
        </div>
      )}

      <div className="card cmp-card">
        <div className="cmp-head">
          <div className="cmp-col-h prev">попередній</div>
          <div className="cmp-col-h cur">поточний</div>
          <div className="cmp-col-h" />
        </div>
        <div className="cmp-row cmp-total">
          <span className="cmp-name">Витрати всього</span>
          <span className="cmp-b">{formatMinor(data.b.spend, { decimals: false })} {sign}</span>
          <span className="cmp-a">{formatMinor(data.a.spend, { decimals: false })} {sign}</span>
          <DeltaChip a={data.a.spend} b={data.b.spend} />
        </div>
        {rows.map((r, i) => (
          <HoverTip key={i} content={
            <><div className="tip-lbl">{r.name}</div>
            <div className="r">попередній: {formatMinor(r.b, { decimals: false })} {sign}</div>
            <div className="r">поточний: {formatMinor(r.a, { decimals: false })} {sign}</div></>
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
          <div className="cmp-row" title="Решта категорій поза топ-10">
            <span className="cmp-name"><span className="d" style={{ background: "var(--muted)" }} />інші категорії</span>
            <span className="cmp-b">{formatMinor(rest.b, { decimals: false })} {sign}</span>
            <span className="cmp-a">{formatMinor(rest.a, { decimals: false })} {sign}</span>
            <DeltaChip a={rest.a} b={rest.b} />
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>Перекази і зняття виключено з порівняння.</p>
      </div>
    </section>
  );
}

// Глибша аналітика (обчислювана, без AI-вартості) — графіки по 2 в колонку + опис (§F1).
// Працює, коли бакет = день (тиждень/місяць): з денних сум виводимо патерни витрат.
const WD = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const FULL_WD = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
function DeeperAnalytics({ series, sign, from, to, currency }: {
  series: Overview["series"]; sign: string; from: number; to: number; currency: Cur;
}) {
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
      <div className="section-head"><h2>Глибша аналітика</h2><span className="label">патерни витрат</span></div>
      <div className="stat-facts" style={{ marginBottom: 10 }}>
        <button type="button" className={`fact fact-click ${openPriciest ? "open" : ""}`}
          disabled={!priciest || !(priciest.spend > 0)}
          onClick={() => setOpenPriciest((o) => !o)}>
          <FactLabel info={<>День періоду з найбільшою сумою витрат. Клікни, щоб побачити, що саме куплено того дня.</>}>Найдорожчий день ›</FactLabel>
          <span className="fact-val">{priciest && priciest.spend > 0 ? <>{labelFor(priciest.bucket)} · {formatMinor(priciest.spend, { decimals: false })} {sign}</> : "—"}</span>
        </button>
        <div className="fact">
          <FactLabel info={<>Скільки календарних днів періоду пройшло без жодної витратної операції (не рахуємо доходи й перекази). Багато таких днів — витрати сконцентровані у кілька дат.</>}>Днів без витрат</FactLabel>
          <span className="fact-val">{noSpendDays} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>з {totalDays}</span></span>
        </div>
      </div>
      {openPriciest && priciest && priciest.spend > 0 && (
        <div className="card drill-open-card" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 6 }}>{labelFor(priciest.bucket)} — операції за день</div>
          <SliceDrillPanel dim="day" value={priciest.bucket} from={from} to={to} currency={currency} sign={sign} embedded />
        </div>
      )}
      <div className="stats-2col">
        <div className="card deep-card">
          <div className="deep-title">Витрати по днях тижня <span className="label" style={{ fontWeight: 400 }}>· клік — що куплено</span></div>
          <div className="wd-bars">
            {byWeekday.map((v, i) => (
              <HoverTip key={i} content={
                <><div className="tip-lbl">{FULL_WD[i]}</div>
                <div className="r">{formatMinor(v, { decimals: false })} {sign}</div>
                <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{Math.round((v / total) * 100)}% періоду</div></>
              }>
                <button type="button" className={`wd-col ${openWd === i ? "open" : ""}`}
                  onClick={() => setOpenWd(openWd === i ? null : i)}>
                  <div className="wd-bar-wrap"><div className="wd-bar" style={{ height: `${(v / wdMax) * 100}%`, background: i === topWd || i === openWd ? "var(--accent)" : "var(--line-strong)" }} /></div>
                  <span className="wd-lbl">{WD[i]}</span>
                </button>
              </HoverTip>
            ))}
          </div>
          <p className="deep-desc">Найбільше витрачаєш у <b>{["неділю", "понеділок", "вівторок", "середу", "четвер", "пʼятницю", "суботу"][topWd]}</b> — {formatMinor(byWeekday[topWd], { decimals: false })} {sign} за період.</p>
          {openWd != null && (
            <div className="wd-drill">
              <div className="label" style={{ marginBottom: 2 }}>{FULL_WD[openWd]} — операції за період</div>
              <SliceDrillPanel dim="weekday" value={String(openWd)} from={from} to={to} currency={currency} sign={sign} />
            </div>
          )}
        </div>

        <div className="card deep-card">
          <div className="deep-title">Будні vs вихідні</div>
          <div className="split-bar">
            <HoverTip content={<><div className="tip-lbl">Будні</div><div className="r">{formatMinor(weekdaySum, { decimals: false })} {sign} · {100 - weekendPct}%</div></>}>
              <div className="split-seg" style={{ width: `${100 - weekendPct}%`, background: "var(--c-cobalt, var(--accent))" }}>{100 - weekendPct}%</div>
            </HoverTip>
            <HoverTip content={<><div className="tip-lbl">Вихідні</div><div className="r">{formatMinor(weekendSum, { decimals: false })} {sign} · {weekendPct}%</div></>}>
              <div className="split-seg alt" style={{ width: `${weekendPct}%`, background: "var(--c-teal)" }}>{weekendPct}%</div>
            </HoverTip>
          </div>
          <div className="split-legend">
            <span><span className="d" style={{ background: "var(--accent)" }} />Будні · {formatMinor(weekdaySum, { decimals: false })} {sign}</span>
            <span><span className="d" style={{ background: "var(--c-teal)" }} />Вихідні · {formatMinor(weekendSum, { decimals: false })} {sign}</span>
          </div>
          <p className="deep-desc">{weekendPct >= 40 ? "Вихідні зʼїдають помітну частку — там найлегше зекономити." : "Основні витрати в будні — вихідні під контролем."}</p>
        </div>
      </div>

      {hasDom && (
        <div className="card deep-card" style={{ marginTop: 14 }}>
          <div className="deep-title">Витрати за числом місяця <span className="label" style={{ fontWeight: 400 }}>· темніше = більше · клік — операції</span></div>
          <div className="dom-heat">
            {byDom.map((v, i) => {
              const intensity = v > 0 ? 0.15 + 0.85 * (v / domMax) : 0;
              const dom = i + 1;
              return (
                <HoverTip key={i} content={<><div className="tip-lbl">{dom}-е число</div><div className="r">{formatMinor(v, { decimals: false })} {sign}</div></>}>
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
              <div className="label" style={{ marginBottom: 6 }}>{openDom}-е число місяця — операції за період</div>
              <SliceDrillPanel dim="dom" value={String(openDom)} from={from} to={to} currency={currency} sign={sign} embedded />
            </div>
          )}
          <p className="deep-desc">Дні місяця з найбільшими витратами — часто це оренда, підписки чи регулярні платежі.</p>
        </div>
      )}
    </section>
  );
}

// §6: смуга частки витрат за вагомістю (обов'язкові / бажані / необов'язкові).
// §E1/E2/E3: детерміновані патерни витрат цього місяця (без AI).
function SpendingPatterns() {
  const { data } = useGetPatternsQuery();
  if (!data) return null;
  const { recurring, anomalies, pace } = data;
  const reg = recurring.recurring.spent;
  const one = recurring.oneoff.spent;
  const tot = reg + one;
  const dfmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "short" });
  const hasAny = tot > 0 || anomalies.length > 0 || pace.length > 0;
  if (!hasAny) return null;

  return (
    <>
      {tot > 0 && (
        <section>
          <div className="section-head">
            <h2>Разові vs регулярні</h2>
            <HoverTip content={<>Регулярні — витрати в мерчантів, що повторюються з місяця в місяць (продукти, транспорт, підписки). Разові — все інше (податки, стоматолог, велика покупка). Так видно «нормальний» місяць без викидів. <b>Цей місяць.</b></>}>
              <span className="label">цей місяць · що це?</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div className="split-bar">
              {reg > 0 && <span style={{ width: `${(reg / tot) * 100}%`, background: "var(--accent)" }} title={`Регулярні: ${Math.round((reg / tot) * 100)}%`} />}
              {one > 0 && <span style={{ width: `${(one / tot) * 100}%`, background: "var(--c-teal)" }} title={`Разові: ${Math.round((one / tot) * 100)}%`} />}
            </div>
            <div className="imp-legend">
              <span className="lg"><span className="d" style={{ background: "var(--accent)" }} />Регулярні · <b>{formatMinor(reg, { decimals: false })} ₴</b> <span className="muted">({recurring.recurring.n} оп)</span></span>
              <span className="lg"><span className="d" style={{ background: "var(--c-teal)" }} />Разові · <b>{formatMinor(one, { decimals: false })} ₴</b> <span className="muted">({recurring.oneoff.n} оп)</span></span>
            </div>
            {recurring.oneoff_items.length > 0 && (
              <div className="oneoff-list">
                <div className="label" style={{ marginBottom: 6 }}>Найбільші разові</div>
                {recurring.oneoff_items.map((it, i) => (
                  <div key={i} className="oneoff-row">
                    <span className="oor-name">{it.merchant ?? it.category ?? "операція"}</span>
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
            <h2>Радар аномалій</h2>
            <HoverTip content={<>Категорії, де <b>регулярний</b> темп цього місяця помітно вищий за звичний (середнє за 6 міс). Разові витрати (податки, лікування) сюди не потрапляють — вони вже сталися й не проєктуються.</>}>
              <span className="label">що це?</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 8 }}>
            {anomalies.map((a, i) => (
              <div key={i} className="anomaly warn">
                <span className="an-dot" style={{ background: a.color ?? undefined }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{a.category}</b>
                  <div className="muted" style={{ fontSize: 13 }}>
                    прогноз ≈{formatMinor(a.projected, { decimals: false })} ₴ проти звичних {formatMinor(a.usual, { decimals: false })} ₴
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
            <h2>Темп по категоріях</h2>
            <HoverTip content={<>Скільки вже витрачено цього місяця (факт), прогноз на кінець місяця й твій звичний місяць. Прогноз = вже витрачене + історичний залишок; разові й лумпи (податки, оренда, заправка) не розганяються. Бейдж — прогноз відносно звичного: &lt;100% нижче норми, &gt;100% вище.</>}>
              <span className="label">факт · прогноз · звичне</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 8 }}>
            {pace.map((p, i) => (
              <div key={i} className="pace-row">
                <span className="pace-name">
                  <span className="d" style={{ background: p.color ?? "var(--accent)" }} />{p.category}
                  {(p.mostly_oneoff || p.lumpy) && <span className="pace-tag" title="Витрата тут — разова або зосереджена в 1-2 великих платежах (податок, оренда, заправка); прогноз її не множить">не щоденне</span>}
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

function ImportanceBreakdown({ data, sign, from, to, currency }: { data: Overview; sign: string; from: number; to: number; currency: Cur }) {
  const rows = data.byImportance ?? [];
  const total = rows.reduce((s, r) => s + Math.abs(r.spent), 0);
  const [open, setOpen] = useState<Importance | null>(null);
  if (!total) return null;
  const byLevel = (lv: string) => Math.abs(rows.find((r) => r.importance === lv)?.spent ?? 0);
  return (
    <section>
      <div className="section-head">
        <h2>Вагомість витрат</h2>
        <HoverTip content={<>Скільки з витрат — <b>обов'язкові</b> (не поріжеш), <b>бажані</b> (гнучкі) чи <b>необов'язкові</b> (можна не робити). Задається на категорії, операція може перевизначати. Клікни блок — побачиш ці операції.</>}>
          <span className="label">що це?</span>
        </HoverTip>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <div className="imp-bar imp-bar-lg">
          {IMPORTANCE_LEVELS.map((lv) => {
            const v = byLevel(lv);
            if (!v) return null;
            const pct = Math.round((v / total) * 100);
            return (
              <span key={lv} style={{ width: `${(v / total) * 100}%`, background: IMPORTANCE_META[lv].color }} title={`${IMPORTANCE_META[lv].label}: ${pct}%`}>
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
                <span className="imp-card-top"><span className="d" style={{ background: IMPORTANCE_META[lv].color }} />{IMPORTANCE_META[lv].label} ›</span>
                <span className="imp-card-amt num-hero">{formatMinor(v, { decimals: false })} {sign}</span>
                <span className="imp-card-pct muted">{pct}% витрат</span>
              </button>
            );
          })}
        </div>
        {open && byLevel(open) > 0 && (
          <div className="drill-open-card" style={{ marginTop: 12 }}>
            <div className="label" style={{ marginBottom: 6 }}>{IMPORTANCE_META[open].label} — операції за період</div>
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
          <span>vs минулий</span>
        </div>
      ) : (
        <div className="kpi-foot"><span>за період</span></div>
      )}
    </>
  );
}
