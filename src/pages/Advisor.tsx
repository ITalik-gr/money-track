import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  useGenerateAdviceMutation,
  useGetAdviceQuery,
  useGetAdviceHistoryQuery,
  useClearAdviceHistoryMutation,
  useSetBudgetMutation,
} from "../store/api.ts";
import type { AdviceAction, Advice, AdviceHistoryItem } from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { AiInsightCard } from "../components/AiInsightCard.tsx";
import { WhatIf } from "../components/WhatIf.tsx";
import { RichFacts } from "../components/RichFacts.tsx";
import { FactsCard } from "../components/FactsCard.tsx";
import { HealthIndexCard } from "../components/HealthIndexCard.tsx";
import { KnowledgeCorpusCard } from "../components/KnowledgeCorpusCard.tsx";
import { UsageCost } from "../components/UsageCost.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { highlightAmounts } from "../lib/highlight.tsx";
import { renderRich } from "../lib/citations.tsx";
import { formatMinor } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";
import { toast } from "../lib/toast.ts";

// AI-порадник: числа (runway) + структуровані поради + інтерактивне «запитай/опиши».
// Профіль «про мене» редагується лише в Налаштуваннях — AI його й так знає в усіх викликах.
const TABS = { advice: "Поради", state: "Стан фінансів" } as const;
type AdvTab = keyof typeof TABS;

export function Advisor() {
  const { data: advice } = useGetAdviceQuery();
  const [generate, { isLoading: generating }] = useGenerateAdviceMutation();
  const [genError, setGenError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const tab: AdvTab = params.get("tab") === "state" ? "state" : "advice";
  const setTab = (t: AdvTab) => setParams((p) => { p.set("tab", t); return p; }, { replace: true });

  async function runAdvice() {
    setGenError(null);
    try {
      await generate().unwrap();
    } catch (e) {
      const raw = (e as { data?: { error?: string } })?.data?.error ?? String(e);
      const friendly = raw.includes("not set")
        ? "AI-ключ не налаштовано на цьому середовищі."
        : "Не вдалося отримати поради. Спробуй ще раз.";
      setGenError(friendly);
      toast.error(friendly);
    }
  }

  const months = advice?.runway_months ?? null;
  const tone = months == null ? "accent" : months >= 6 ? "pos" : months >= 3 ? "warn" : "neg";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Порадник</div>
          <div className="sub">AI дивиться на твої числа й радить конкретні кроки під твою ситуацію.</div>
        </div>
        <div className="page-head-actions">
          <Link to="/chat" className="btn ghost">Запитати в чаті →</Link>
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as AdvTab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {TABS[k]}
          </button>
        ))}
      </div>

      {tab === "state" && (
        <div className="advisor-state">
          <HealthIndexCard />
          <FactsCard />
          <KnowledgeCorpusCard />
        </div>
      )}

      {tab === "advice" && (
      <div className="stack" style={{ gap: 18 }}>
        {advice && (
          <div className="card runway-card">
            <Gauge
              ratio={months != null ? Math.max(0, months) / 12 : 0}
              center={months != null ? String(Math.max(0, months)) : "—"}
              sub={months != null ? "місяців" : "нема даних"}
              tone={tone}
            />
            <div className="runway-metrics situation-metrics">
              <Metric label="Реальна подушка" v={<Money minor={advice.cushion} decimals={false} />} tone="pos"
                info="Скільки реально є: заощадження й плюсові рахунки (у ₴, USD зведено за курсом). Це не нетто — борг по кредитці рахується окремо." />
              {advice.debt > 0 && (
                <Metric label="Борг по кредитці" v={<Money minor={advice.debt} decimals={false} />} tone="neg"
                  info="Використаний кредитний ліміт. Це борг, а не «мінус запас» — не змішується з подушкою." />
              )}
              {advice.investment != null && advice.investment > 0 && (
                <Metric label="Інвест-резерв" v={<Money minor={advice.investment} decimals={false} />}
                  info="Крипта/брокер та інші інвестиційні рахунки. Це не ліквідна подушка й не входить у runway — остання лінія на крайній випадок." />
              )}
              <Metric label="Витрати / міс" v={<Money minor={advice.monthly_burn} decimals={false} />} />
              <Metric label="Подушки вистачить на" v={months != null ? `${Math.max(0, months)} міс` : "—"} tone={tone}
                info="Ліквідна подушка ÷ середні місячні витрати. Скільки протягнеш на реальні кошти за поточного темпу." />
            </div>
            {advice.runway_comment && <p className="runway-comment" style={{ gridColumn: "1 / -1" }}>{highlightAmounts(advice.runway_comment)}</p>}
          </div>
        )}

        <WhatIf />

        <div className="advisor-grid">
          {/* Головна колонка — структуровані поради */}
          <section className="advisor-main">
            <div className="section-head">
              <h2>Поради на твоїх числах</h2>
              <button className="btn primary sm" onClick={runAdvice} disabled={generating}>
                {generating ? "Аналізую…" : advice ? "Оновити" : "Отримати"}
              </button>
            </div>

            {advice?.suggestions?.length ? (
              <div className="stack">
                <SinceLastTime advice={advice} />
                {advice.summary && <p className="ai-text" style={{ margin: "0 2px 6px" }}>{renderRich(advice.summary)}</p>}
                {advice.suggestions.map((s, i) => (
                  <div key={i} className="card advice-card">
                    <div className="advice-num">{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="advice-title">{s.title}</div>
                      <div className="advice-detail">{renderRich(s.detail)}</div>
                      {s.action && <AdviceActionButton action={s.action} />}
                    </div>
                  </div>
                ))}
                <div className="row" style={{ justifyContent: "space-between", marginTop: 2 }}>
                  <span className="label">
                    станом на {new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format((advice?.generated_at ?? 0) * 1000)}
                  </span>
                  <UsageCost usage={advice?.usage} />
                </div>
              </div>
            ) : genError ? (
              <div className="card empty">{genError} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={runAdvice} disabled={generating}>Ще раз</button></div>
            ) : (
              <div className="card empty">Натисни «Отримати» — AI врахує твої числа, цілі й профіль із Налаштувань.</div>
            )}
          </section>

          {/* Правий рейл — розбивка коштів + AI-огляд + історія (заповнює ширину) */}
          <aside className="stack advisor-rail" style={{ gap: 18 }}>
            {advice?.facts && advice.facts.length > 0 && (
              <div className="card" style={{ padding: 16 }}>
                <RichFacts facts={advice.facts} />
              </div>
            )}
            <AiInsightCard days={30} />
            <AdviceHistory />
          </aside>
        </div>
      </div>
      )}
    </>
  );
}

// Дельта-пілюля: зміна метрики vs минулого разу. `goodUp` — чи «більше = краще»
// (runway/подушка так; burn навпаки — менше краще). Гроші показуємо у ₴.
function DeltaPill({ cur, prev, goodUp, money, unit }: { cur: number | null; prev: number | null; goodUp: boolean; money?: boolean; unit?: string }) {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < (money ? 100 : 0.05)) return <span className="cmp-delta flat">без змін</span>;
  const good = goodUp ? diff > 0 : diff < 0;
  const abs = money ? `${formatMinor(Math.abs(diff), { decimals: false })} ₴` : `${Math.abs(Math.round(diff * 10) / 10)}${unit ?? ""}`;
  return <span className={`cmp-delta ${good ? "down" : "up"}`}>{diff > 0 ? "+" : "−"}{abs}</span>;
}

// §+1: «зміни від минулого разу» — порівняння поточної поради з попереднім знімком історії.
function SinceLastTime({ advice }: { advice: Advice }) {
  const { data: hist } = useGetAdviceHistoryQuery();
  const prev = (hist ?? []).find((h) => h.generated_at < advice.generated_at);
  if (!prev) return null;
  const dfmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "short" });
  return (
    <div className="card since-last" style={{ padding: "10px 14px" }}>
      <span className="label">від {dfmt.format(prev.generated_at * 1000)}:</span>
      <span className="since-metric">Runway <DeltaPill cur={advice.runway_months} prev={prev.runway_months} goodUp unit="м" /></span>
      <span className="since-metric">Витрати/міс <DeltaPill cur={advice.monthly_burn} prev={prev.monthly_burn} goodUp={false} money /></span>
      <span className="since-metric">Подушка <DeltaPill cur={advice.cushion} prev={prev.cushion ?? null} goodUp money /></span>
    </div>
  );
}

// §2/§+1: історія порад — тренд runway + знімки з дельтами; можна очистити.
function AdviceHistory() {
  const { data: hist } = useGetAdviceHistoryQuery();
  const [clear, { isLoading: clearing }] = useClearAdviceHistoryMutation();
  if (!hist || hist.length < 2) return null;
  const dfmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "short" });

  // Хронологічний ряд для тренду runway (від старих до нових; лише зі значенням).
  const chrono = [...hist].reverse();
  const runwayPts = chrono
    .filter((h) => h.runway_months != null)
    .map((h) => ({ t: h.generated_at, runway: h.runway_months as number, label: dfmt.format(h.generated_at * 1000) }));

  async function onClear() {
    if (!confirm("Очистити всю історію порад?")) return;
    try { await clear().unwrap(); } catch { toast.error("Не вдалося очистити."); }
  }

  return (
    <section>
      <div className="section-head">
        <h2>Історія порад</h2>
        <button className="btn ghost sm" onClick={onClear} disabled={clearing}>Очистити</button>
      </div>

      {runwayPts.length >= 2 && (
        <div className="card" style={{ padding: "12px 8px 4px", marginBottom: 10 }}>
          <span className="label" style={{ padding: "0 8px" }}>Runway, місяців</span>
          <div className="chart-wrap" style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runwayPts} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={28} tick={{ fontSize: 11, fill: "var(--muted)" }} />
                <YAxis tickLine={false} axisLine={false} width={40} tickCount={4} tick={{ fontSize: 11, fill: "var(--muted)" }} />
                <Tooltip
                  cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={(props: any) => {
                    const p = props?.active && props?.payload?.[0]?.payload;
                    return p ? <div className="chart-tip"><div className="tip-lbl">{p.label}</div><div className="r"><span className="d" style={{ background: "var(--accent)" }} />{p.runway} міс</div></div> : null;
                  }}
                />
                <Line type="monotone" dataKey="runway" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" dot={{ r: 2.5 }} activeDot={{ r: 3.5 }} {...CHART_ANIM} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 8 }}>
        {hist.map((h, i) => {
          const prev: AdviceHistoryItem | undefined = hist[i + 1]; // наступний = старіший
          return (
            <div key={h.generated_at} className="adv-hist-row">
              <span className="adv-hist-date">{dfmt.format(h.generated_at * 1000)}</span>
              <span className="adv-hist-sum">{h.summary || "—"}</span>
              <span className="adv-hist-nums">
                {h.runway_months != null && (
                  <>runway <b>{h.runway_months}м</b> {prev && <DeltaPill cur={h.runway_months} prev={prev.runway_months} goodUp unit="м" />} · </>
                )}
                burn <b><Money minor={h.monthly_burn} decimals={false} /></b>/міс {prev && <DeltaPill cur={h.monthly_burn} prev={prev.monthly_burn} goodUp={false} money />}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Дієва порада: створити конверт-ліміт прямо з поради (§дієві поради).
function AdviceActionButton({ action }: { action: AdviceAction }) {
  const [setBudget, { isLoading }] = useSetBudgetMutation();
  const [done, setDone] = useState(false);
  if (!action.category_id || !action.amount_uah) return null;
  return (
    <button
      className="btn primary sm" style={{ marginTop: 10 }}
      disabled={isLoading || done}
      onClick={async () => {
        try { await setBudget({ category_id: action.category_id!, period: "month", amount: Math.round(action.amount_uah! * 100) }).unwrap(); } catch { /* ignore */ }
        setDone(true);
      }}
    >
      {done ? "✓ Конверт створено" : (action.label || "Створити конверт")}
    </button>
  );
}

function Metric({ label, v, tone, info }: { label: string; v: React.ReactNode; tone?: string; info?: string }) {
  return (
    <div className="runway-metric">
      <div className="label" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}{info && <InfoTip>{info}</InfoTip>}</div>
      <div className={`runway-val num-hero ${tone === "pos" ? "pos" : tone === "neg" ? "neg" : tone === "warn" ? "" : ""}`}>{v}</div>
    </div>
  );
}
