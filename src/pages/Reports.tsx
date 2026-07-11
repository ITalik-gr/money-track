import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useGetReportsQuery, useGetReportQuery, useGenerateReportMutation } from "../store/api.ts";
import type { ReportListItem, FinancialReport } from "../store/api.ts";
import { toast } from "../lib/toast.ts";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { formatMinor } from "../lib/format.ts";
import { renderRich } from "../lib/citations.tsx";
import { CashflowChart } from "../components/CashflowChart.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { IMPORTANCE_LEVELS, IMPORTANCE_META } from "../lib/importance.ts";

const rDate = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" });
const rDateTime = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function periodLabel(r: ReportListItem): string {
  const t = r.period_type === "week" ? "Тиждень" : "Місяць";
  return `${t} · ${rDate.format(r.period_from * 1000)} – ${rDate.format(r.period_to * 1000)}`;
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
  const { data: reports } = useGetReportsQuery();
  const [generate, { isLoading }] = useGenerateReportMutation();
  const [busy, setBusy] = useState<"week" | "month" | null>(null);
  const navigate = useNavigate();

  const run = async (type: "week" | "month") => {
    setBusy(type);
    try {
      // scope='current' — поточний період до сьогодні (тест / «як іде тиждень/місяць»).
      const r = await generate({ type, force: true, scope: "current" }).unwrap();
      toast.success("Репорт готовий");
      navigate(`/reports/${r.id}`);
    } catch (e) { toast.error(String(e)); }
    finally { setBusy(null); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Репорти</div>
          <div className="sub">Розгорнутий AI-розбір періоду: категорії, аномалії, прогнози, поради.</div>
        </div>
      </div>

      <div className="card ai-block" style={{ marginBottom: 16 }}>
        <div className="ai-block-head"><span className="ai-block-title">🧠 Згенерувати</span></div>
        <p className="ai-block-hint">
          Авто щотижня + щомісяця (за завершений період). Кнопки нижче — <b>за поточний період до сьогодні</b>.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" disabled={isLoading} onClick={() => run("week")}>
            {busy === "week" ? "Генерую…" : "✨ За тиждень"}
          </button>
          <button className="btn" disabled={isLoading} onClick={() => run("month")}>
            {busy === "month" ? "Генерую…" : "За місяць"}
          </button>
        </div>
      </div>

      {(reports ?? []).length === 0 && <div className="card empty">Ще немає репортів. Згенеруй перший вище.</div>}

      <div className="report-cards">
        {(reports ?? []).map((r) => (
          <Link key={r.id} to={`/reports/${r.id}`} className="report-card">
            <div className="rc-top">
              <span className={`rc-badge ${r.period_type}`}>{r.period_type === "week" ? "тиждень" : "місяць"}</span>
              <span className="rc-date">{rDate.format(r.period_from * 1000)} – {rDate.format(r.period_to * 1000)}</span>
            </div>
            {r.summary && <div className="rc-summary">{r.summary}</div>}
            <div className="rc-foot">
              <span>{rDateTime.format(r.created_at * 1000)}</span>
              <span className="rc-open">відкрити →</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

// ---- Деталь репорту (сторінка /reports/:id) --------------------------------
export function ReportDetail() {
  const { id } = useParams();
  const nid = Number(id);
  const { data, isFetching } = useGetReportQuery(nid, { skip: !nid });

  if (isFetching) return <div className="empty">Завантаження…</div>;
  if (!data) return (
    <div className="card empty">Репорт не знайдено. <Link to="/reports" className="group-link">до списку →</Link></div>
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
          <Link to="/reports" className="label group-link">← усі репорти</Link>
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
            <div className="section-head"><h2>Розбір</h2></div>
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

        {r.category_breakdown?.length > 0 && (
          <section>
            <div className="section-head"><h2>Категорії</h2><InfoTip>Дельта — проти того самого попереднього періоду. Готівка й зняття зараховані за реальною категорією, перекази між своїми виключені, валюти зведені в ₴.</InfoTip><span className="label">vs минулий період</span></div>
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
                        <span className="cb-pct">{isNew ? <span className="cmp-delta new">новий</span> : <Delta pct={c.delta_pct} />}</span>
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
            <div className="section-head"><h2>Тренд</h2><InfoTip>Витрати й надходження по місяцях за останні 6 місяців (зведено в ₴). Поточний місяць може бути неповним.</InfoTip><span className="label">витрати й надходження, 6 міс</span></div>
            <div className="card cashflow">
              <div className="legend" style={{ justifyContent: "flex-end", padding: "2px 4px 8px" }}>
                <span><span className="d" style={{ background: "var(--chart-income)" }} />Надходження</span>
                <span><span className="d" style={{ background: "var(--chart-expense)" }} />Витрати</span>
              </div>
              <CashflowChart height={220} rows={r.trend.map((t) => ({ label: monthLabel(t.month), spend: t.spend_uah, income: t.income_uah }))} />
            </div>
          </section>
        )}

        {r.anomalies?.length > 0 && (
          <section>
            <div className="section-head"><h2>Аномалії</h2><InfoTip>Незвичні або разові витрати цього періоду та подорожчання підписок. Разові події (податки, лікування, велика покупка) не вважаються трендом.</InfoTip></div>
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
            <div className="section-head"><h2>Поради</h2></div>
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
          {data.model && <span>модель: {data.model.replace("claude-", "")}</span>}
          {data.cost_usd != null && <span> · ≈${data.cost_usd < 0.01 ? data.cost_usd.toFixed(4) : data.cost_usd.toFixed(2)}</span>}
        </div>
      </div>
    </>
  );
}

// §B: прогноз — hero-блок нагорі репорту (великі числа: очікувані витрати + запас-runway).
function ForecastHero({ p }: { p: FinancialReport["predictions"] }) {
  if (!p || (p.next_period_spend_uah == null && p.runway_months == null && !p.note)) return null;
  return (
    <section>
      <div className="section-head"><h2>Прогноз</h2><InfoTip>Очікувані витрати — на основі середнього за завершені місяці (не разові викиди). Запас (runway) = ліквідна подушка ÷ місячний темп витрат; борг по кредитці рахується окремо.</InfoTip><span className="label">погляд уперед</span></div>
      <div className="card forecast-hero">
        <div className="fh-nums">
          {p.next_period_spend_uah != null && (
            <div className="fh-item">
              <span className="fh-label">Очікувані витрати</span>
              <span className="fh-val">{formatMinor(p.next_period_spend_uah * 100, { decimals: false })} ₴</span>
            </div>
          )}
          {p.runway_months != null && (
            <div className="fh-item">
              <span className="fh-label">Запас (runway)</span>
              <span className="fh-val">{p.runway_months} <span className="fh-unit">міс</span></span>
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
  const total = data.reduce((s, d) => s + Math.abs(d.amount_uah), 0);
  if (!total) return null;
  const byLevel = (lv: string) => data.find((d) => d.level === lv);
  return (
    <section>
      <div className="section-head"><h2>Вагомість витрат</h2><InfoTip>Розподіл витрат за вагомістю: обов'язкові (essential) — базові потреби; бажані (discretionary); необов'язкові (optional) — найбезпечніші для скорочення. Задається на категорії, з override на транзакції.</InfoTip><span className="label">обов'язкові · бажані · необов'язкові</span></div>
      <div className="card" style={{ padding: 16 }}>
        <div className="imp-bar">
          {IMPORTANCE_LEVELS.map((lv) => {
            const row = byLevel(lv);
            if (!row?.amount_uah) return null;
            return <span key={lv} style={{ width: `${(Math.abs(row.amount_uah) / total) * 100}%`, background: IMPORTANCE_META[lv].color }} title={`${IMPORTANCE_META[lv].label}: ${row.pct}%`} />;
          })}
        </div>
        <div className="imp-legend">
          {IMPORTANCE_LEVELS.map((lv) => {
            const row = byLevel(lv);
            if (!row) return null;
            return (
              <span key={lv} className="lg">
                <span className="d" style={{ background: IMPORTANCE_META[lv].color }} />
                {IMPORTANCE_META[lv].label} · <b>{row.pct}%</b> <span className="muted">({formatMinor(row.amount_uah * 100, { decimals: false })} ₴)</span>
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

const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
function monthLabel(m: string): string { const p = m.split("-"); return MONTHS[Number(p[1]) - 1] ?? m; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DonutTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{d.name}</div>
      <div className="r"><span className="d" style={{ background: d.payload.color }} />{formatMinor(d.value * 100, { decimals: false })} ₴</div>
      <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{d.payload.pct}% від суми</div>
    </div>
  );
}

// §5: донат розподілу витрат по категоріях (топ-8 + «інші»).
function CategoryDonut({ cats }: { cats: { name: string; amount_uah: number }[] }) {
  const top = cats.slice(0, 8).map((c, i) => ({ name: c.name, value: Math.abs(c.amount_uah), color: barColor(i) }));
  const restSum = cats.slice(8).reduce((s, c) => s + Math.abs(c.amount_uah), 0);
  if (restSum > 0) top.push({ name: "інші", value: restSum, color: "#9aa5a0" });
  const total = top.reduce((s, d) => s + d.value, 0);
  if (!total) return null;
  const withPct = top.map((d) => ({ ...d, pct: Math.round((d.value / total) * 100) }));
  return (
    <div className="report-donut">
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={withPct} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={54} outerRadius={82} paddingAngle={1.5} strokeWidth={0}>
            {withPct.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip content={<DonutTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center">
        <span className="dc-val">{formatMinor(total * 100, { decimals: false })} ₴</span>
        <span className="dc-lbl">витрат</span>
      </div>
    </div>
  );
}
