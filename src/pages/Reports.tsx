import { useState } from "react";
import { getLocale, dateFmt } from "../i18n/locale.ts";
import { useT, translate } from "../i18n/index.ts";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useGetReportsQuery, useGetReportQuery, useGenerateReportMutation, useDeleteReportMutation } from "../store/api.ts";
import type { ReportListItem, FinancialReport } from "../store/api.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_ANIM } from "../lib/motion.ts";
import { formatMinor, monthShort } from "../lib/format.ts";
import { renderRich } from "../lib/citations.tsx";
import { CashflowChart } from "../components/stats/CashflowChart.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { IMPORTANCE_LEVELS, IMPORTANCE_META } from "../lib/importance.ts";

const rDate = dateFmt({ day: "numeric", month: "short" });
const rDateTime = dateFmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// `period_to` — це ПОЧАТОК наступного періоду (так їх рахує `lastCompletePeriod`), тож
// показувати його як кінець означає обіцяти день, якого в репорті нема: тиждень 13–19 липня
// підписувався «13 – 20 лип». Віднімаємо секунду й показуємо реальний останній день.
function rangeLabel(from: number, to: number): string {
  return `${rDate.format(from * 1000)} – ${rDate.format((to - 1) * 1000)}`;
}

const TYPE_KEY = { week: "report.week", month: "report.month", custom: "report.customBadge" } as const;

function periodLabel(r: ReportListItem): string {
  const label = translate(getLocale(), TYPE_KEY[r.period_type] ?? "report.customBadge");
  return `${label} · ${rangeLabel(r.period_from, r.period_to)}`;
}

/** `YYYY-MM-DD` → unix опівночі ЛОКАЛЬНОГО дня. Користувач обирає дати у своєму поясі, і саме
 *  так їх треба інтерпретувати — інакше вечірні операції останнього дня випадають зі звіту. */
function dayStartUnix(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

// Дельта-чіп у стилі Статистики: зростання витрат — червоне, спад — зелене.
function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  if (pct === 0) return <span className="cmp-delta flat">0%</span>;
  const cls = pct > 0 ? "up" : "down";
  return <span className={`cmp-delta ${cls}`}>{pct > 0 ? "+" : ""}{pct}%</span>;
}

// ---- Список репортів (сторінка /reports) -----------------------------------
export function Reports() {
  const t = useT();
  const { data: reports } = useGetReportsQuery();
  const [generate, { isLoading }] = useGenerateReportMutation();
  const [deleteReport] = useDeleteReportMutation();
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  // Локальна «сьогодні», не `toISOString()`: у Києві ввечері UTC-дата вже вчорашня, і `max`
  // на інпуті мовчки забороняв би вибрати сьогоднішній день.
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const run = async (id: string, body: Parameters<typeof generate>[0]) => {
    setBusy(id);
    try {
      const r = await generate(body).unwrap();
      toast.success(t("report.ready"));
      navigate(`/reports/${r.id}`);
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(null); }
  };

  // Пресети. `last` — завершений період (той самий, що рахує крон): саме його не було як
  // згенерувати вручну, бо кнопка завжди слала `current`. `current` лишається окремо — це
  // інше питання («як іде цей тиждень»), а не той самий звіт у процесі.
  const PRESETS = [
    { id: "week:last", label: t("report.forLastWeek"), primary: true, body: { type: "week", scope: "last" } },
    { id: "week:current", label: t("report.forThisWeek"), body: { type: "week", scope: "current" } },
    { id: "month:last", label: t("report.forLastMonth"), body: { type: "month", scope: "last" } },
    { id: "month:current", label: t("report.forThisMonth"), body: { type: "month", scope: "current" } },
  ] as const;

  // Кінець — ексклюзивний (початок наступного дня), як у пресетних періодів: інакше операції
  // останнього обраного дня не потрапили б у звіт.
  const customValid = !!from && !!to && from <= to;
  const runCustom = () => run("custom", {
    type: "custom", force: true,
    from: dayStartUnix(from), to: dayStartUnix(to) + 86400,
  });

  // Видалення тестових репортів. Кнопка всередині картки-Link → гасимо навігацію.
  const remove = async (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t("report.deleteConfirm"))) return;
    try { await deleteReport(id).unwrap(); toast.success(t("report.deleted")); }
    catch (err) { toast.error(errText(err)); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("report.title")}</div>
          <div className="sub">{t("report.sub")}</div>
        </div>
      </div>

      <div className="card ai-block" style={{ marginBottom: 16 }}>
        <div className="ai-block-head"><span className="ai-block-title"><Icon name="spark" size={16} />{t("report.generate")}</span></div>
        <p className="ai-block-hint">{t("report.autoHint")}</p>
        <div className="rep-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className={`btn${"primary" in p && p.primary ? " primary" : ""}`} disabled={isLoading}
              onClick={() => run(p.id, p.body)}>
              {"primary" in p && p.primary && <Icon name="spark" size={15} />}
              {busy === p.id ? t("report.generating") : p.label}
            </button>
          ))}
        </div>

        <div className="rep-custom">
          <div className="label">{t("report.customRange")}</div>
          <div className="filt-range">
            <input type="date" aria-label={t("report.customFrom")} value={from} max={to || today}
              onChange={(e) => setFrom(e.target.value)} />
            <span className="dash">–</span>
            <input type="date" aria-label={t("report.customTo")} value={to} min={from || undefined} max={today}
              onChange={(e) => setTo(e.target.value)} />
            <button className="btn" disabled={isLoading || !customValid} onClick={runCustom}>
              {busy === "custom" ? t("report.generating") : t("report.customGo")}
            </button>
          </div>
        </div>
      </div>

      {(reports ?? []).length === 0 && <div className="card empty">{t("report.empty")}</div>}

      <div className="report-cards">
        {(reports ?? []).map((r) => (
          <Link key={r.id} to={`/reports/${r.id}`} className="report-card">
            <div className="rc-top">
              <span className={`rc-badge ${r.period_type}`}>
                {r.period_type === "week" ? t("report.weekBadge") : r.period_type === "month" ? t("report.monthBadge") : t("report.customBadge")}
              </span>
              <span className="rc-date">{rangeLabel(r.period_from, r.period_to)}</span>
            </div>
            {r.summary && <div className="rc-summary">{r.summary}</div>}
            <div className="rc-foot">
              <span>{rDateTime.format(r.created_at * 1000)}</span>
              <span className="rc-open">{t("report.open")} →</span>
            </div>
            <button type="button" className="rc-del" aria-label={t("report.deleteAria")} title={t("common.delete")} onClick={(e) => remove(e, r.id)}>
              <Icon name="trash" size={15} />
            </button>
          </Link>
        ))}
      </div>
    </>
  );
}

// ---- Деталь репорту (сторінка /reports/:id) --------------------------------
export function ReportDetail() {
  const t = useT();
  const { id } = useParams();
  const nid = Number(id);
  const { data, isFetching } = useGetReportQuery(nid, { skip: !nid });

  if (isFetching) return <div className="empty">{t("common.loading")}</div>;
  if (!data) return (
    <div className="card empty">{t("report.notFound")} <Link to="/reports" className="group-link">{t("report.toList")} →</Link></div>
  );

  const r: FinancialReport = data.data;
  // §R6: рендеримо детерміновані категорії (надійні суми/дельти), fallback — AI-версія (старі репорти).
  type CatRow = { name: string; amount_uah: number; delta_pct: number | null; note?: string | null; prev_uah?: number };
  const hasCatDetail = !!r.categories?.length;
  const catList: CatRow[] = hasCatDetail ? r.categories! : (r.category_breakdown ?? []);
  const catMax = Math.max(1, ...catList.map((c) => Math.abs(c.amount_uah)));
  const sevClass = (s: string) => s === "high" ? "high" : s === "warn" ? "warn" : "info";

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/reports" className="label group-link">← {t("report.allReports")}</Link>
          <div className="greet" style={{ marginTop: 4 }}>{periodLabel(data)}</div>
          {r.headline && <div className="sub">{r.headline}</div>}
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        {r.summary && (
          <div className="card" style={{ padding: 16 }}>
            <p className="ai-text" style={{ margin: 0, lineHeight: 1.55 }}>{renderRich(r.summary)}</p>
          </div>
        )}

        <ForecastHero p={r.predictions} />

        {r.sections?.length > 0 && (
          <section>
            <div className="section-head"><h2>{t("report.breakdown")}</h2></div>
            <div className="card" style={{ padding: 16 }}>
              {r.sections.map((s, i) => (
                <div key={i} style={{ marginTop: i ? 14 : 0 }}>
                  <div className="label" style={{ marginBottom: 3 }}>{s.title}</div>
                  <p style={{ margin: 0, lineHeight: 1.55 }}>{renderRich(s.body)}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Гейт — на `catList` (детермінований `r.categories` із fallback на AI-версію), а НЕ на
            `r.category_breakdown`. Категорії ми рахуємо САМІ й зберігаємо в репорті; коли модель
            не повертала свій масив (напр. відповідь обірвало), зникала вся секція разом із
            нашими власними надійними числами — звіт виглядав порожнім без причини. */}
        {catList.length > 0 && (
          <section>
            <div className="section-head"><h2>{t("report.categories")}</h2><InfoTip>{t("report.categoriesTip")}</InfoTip><span className="label">{t("report.vsPrevPeriod")}</span></div>
            <div className="card" style={{ padding: 16 }}>
              <div className="report-cat-grid">
                <CategoryDonut cats={catList} />
                <div className="catbars" style={{ padding: 0 }}>
                  {catList.map((c, i) => {
                    const isNew = hasCatDetail && (c.prev_uah ?? 0) === 0 && c.amount_uah !== 0;
                    return (
                      <div key={i} className="catbar">
                        <span className="cb-name" title={c.note ?? undefined}><span className="d" style={{ background: barColor(i), width: 9, height: 9, borderRadius: 3, display: "inline-block", marginRight: 7 }} />{c.name}</span>
                        <span className="cb-track"><span className="cb-fill" style={{ width: `${(Math.abs(c.amount_uah) / catMax) * 100}%`, background: barColor(i) }} /></span>
                        <span className="cb-val">{formatMinor(c.amount_uah * 100, { decimals: false })} ₴</span>
                        <span className="cb-pct">{isNew ? <span className="cmp-delta new">{t("stats.compare.newLabel")}</span> : <Delta pct={c.delta_pct} />}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        )}

        {r.importance && r.importance.length > 0 && <ImportanceSection data={r.importance} />}

        {r.trend && r.trend.length > 1 && (
          <section>
            <div className="section-head"><h2>{t("report.trend")}</h2><InfoTip>{t("report.trendTip")}</InfoTip><span className="label">{t("report.trendSub")}</span></div>
            <div className="card cashflow">
              <div className="legend" style={{ justifyContent: "flex-end", padding: "2px 4px 8px" }}>
                <span><span className="d" style={{ background: "var(--chart-income)" }} />{t("common.income")}</span>
                <span><span className="d" style={{ background: "var(--chart-expense)" }} />{t("common.expenses")}</span>
              </div>
              <CashflowChart height={220} rows={r.trend.map((t) => ({ label: monthLabel(t.month), spend: t.spend_uah, income: t.income_uah }))} />
            </div>
          </section>
        )}

        {r.anomalies?.length > 0 && (
          <section>
            <div className="section-head"><h2>{t("report.anomalies")}</h2><InfoTip>{t("report.anomaliesTip")}</InfoTip></div>
            <div className="card" style={{ padding: "6px 14px" }}>
              {r.anomalies.map((a, i) => (
                <div key={i} className={`anomaly ${sevClass(a.severity)}`}>
                  <span className="an-dot" />
                  <div><b>{a.label}</b><div className="muted" style={{ fontSize: 13 }}>{renderRich(a.detail)}</div></div>
                </div>
              ))}
            </div>
          </section>
        )}

        {r.advice?.length > 0 && (
          <section>
            <div className="section-head"><h2>{t("report.advice")}</h2></div>
            <div className="stack" style={{ gap: 10 }}>
              {r.advice.map((a, i) => (
                <div key={i} className="card" style={{ padding: 14 }}>
                  <b>{a.title}</b>
                  <div className="muted" style={{ fontSize: 13.5, marginTop: 3, lineHeight: 1.5 }}>{renderRich(a.detail)}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="report-meta">
          {data.model && <span>{t("report.modelLabel", { model: data.model.replace("claude-", "") })}</span>}
          {data.cost_usd != null && <span> · ≈${data.cost_usd < 0.01 ? data.cost_usd.toFixed(4) : data.cost_usd.toFixed(2)}</span>}
        </div>
      </div>
    </>
  );
}

// §B: прогноз — hero-блок нагорі репорту (великі числа: очікувані витрати + запас-runway).
function ForecastHero({ p }: { p: FinancialReport["predictions"] }) {
  const t = useT();
  if (!p || (p.next_period_spend_uah == null && p.runway_months == null && !p.note)) return null;
  return (
    <section>
      <div className="section-head"><h2>{t("report.forecast")}</h2><InfoTip>{t("report.forecastTip")}</InfoTip><span className="label">{t("report.lookAhead")}</span></div>
      <div className="card forecast-hero">
        <div className="fh-nums">
          {p.next_period_spend_uah != null && (
            <div className="fh-item">
              <span className="fh-label">{t("report.expectedSpend")}</span>
              <span className="fh-val">{formatMinor(p.next_period_spend_uah * 100, { decimals: false })} ₴</span>
            </div>
          )}
          {p.runway_months != null && (
            <div className="fh-item">
              <span className="fh-label">{t("report.runwayReserve")}</span>
              <span className="fh-val">{p.runway_months} <span className="fh-unit">{t("adv.monthsUnit")}</span></span>
            </div>
          )}
        </div>
        {p.note && <p className="fh-note">{renderRich(p.note)}</p>}
      </div>
    </section>
  );
}

// §6: смуга частки витрат за вагомістю (той самий візуал, що в Статистиці).
function ImportanceSection({ data }: { data: NonNullable<FinancialReport["importance"]> }) {
  const t = useT();
  const total = data.reduce((s, d) => s + Math.abs(d.amount_uah), 0);
  if (!total) return null;
  const byLevel = (lv: string) => data.find((d) => d.level === lv);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.importance.title")}</h2><InfoTip>{t("report.importanceTip")}</InfoTip><span className="label">{t("report.importanceSub")}</span></div>
      <div className="card" style={{ padding: 16 }}>
        <div className="imp-bar">
          {IMPORTANCE_LEVELS.map((lv) => {
            const row = byLevel(lv);
            if (!row?.amount_uah) return null;
            return <span key={lv} style={{ width: `${(Math.abs(row.amount_uah) / total) * 100}%`, background: IMPORTANCE_META[lv].color }} title={`${t(IMPORTANCE_META[lv].labelKey)}: ${row.pct}%`} />;
          })}
        </div>
        <div className="imp-legend">
          {IMPORTANCE_LEVELS.map((lv) => {
            const row = byLevel(lv);
            if (!row) return null;
            return (
              <span key={lv} className="lg">
                <span className="d" style={{ background: IMPORTANCE_META[lv].color }} />
                {t(IMPORTANCE_META[lv].labelKey)} · <b>{row.pct}%</b> <span className="muted">({formatMinor(row.amount_uah * 100, { decimals: false })} ₴)</span>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const CAT_COLORS = ["#1f6e4c", "#2e6be6", "#7a3e9d", "#c9871a", "#b23a2e", "#127c86", "#6b7a74", "#3f8f5a", "#4a63d0"];
function barColor(i: number): string { return CAT_COLORS[i % CAT_COLORS.length]; }

function monthLabel(m: string): string { const p = m.split("-"); return monthShort(Number(p[1]) - 1) ?? m; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DonutTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{d.name}</div>
      <div className="r"><span className="d" style={{ background: d.payload.color }} />{formatMinor(d.value * 100, { decimals: false })} ₴</div>
      <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{d.payload.pct}{translate(getLocale(), "report.ofTotal")}</div>
    </div>
  );
}

// §5: донат розподілу витрат по категоріях (топ-8 + «інші»).
function CategoryDonut({ cats }: { cats: { name: string; amount_uah: number }[] }) {
  const t = useT();
  const top = cats.slice(0, 8).map((c, i) => ({ name: c.name, value: Math.abs(c.amount_uah), color: barColor(i) }));
  const restSum = cats.slice(8).reduce((s, c) => s + Math.abs(c.amount_uah), 0);
  if (restSum > 0) top.push({ name: t("report.other"), value: restSum, color: "#9aa5a0" });
  const total = top.reduce((s, d) => s + d.value, 0);
  if (!total) return null;
  const withPct = top.map((d) => ({ ...d, pct: Math.round((d.value / total) * 100) }));
  return (
    <div className="report-donut">
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={withPct} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={54} outerRadius={82} paddingAngle={1.5} strokeWidth={0} {...CHART_ANIM}>
            {withPct.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip content={<DonutTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center">
        <span className="dc-val">{formatMinor(total * 100, { decimals: false })} ₴</span>
        <span className="dc-lbl">{t("report.spendLabel")}</span>
      </div>
    </div>
  );
}
