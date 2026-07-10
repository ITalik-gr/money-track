import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useGenerateAdviceMutation,
  useGetAdviceQuery,
  useGetAdviceHistoryQuery,
  useSetBudgetMutation,
} from "../store/api.ts";
import type { AdviceAction } from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { AiInsightCard } from "../components/AiInsightCard.tsx";
import { RichFacts } from "../components/RichFacts.tsx";
import { UsageCost } from "../components/UsageCost.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { highlightAmounts } from "../lib/highlight.tsx";
import { renderRich } from "../lib/citations.tsx";
import { toast } from "../lib/toast.ts";

// AI-порадник: числа (runway) + структуровані поради + інтерактивне «запитай/опиши».
// Профіль «про мене» редагується лише в Налаштуваннях — AI його й так знає в усіх викликах.
export function Advisor() {
  const { data: advice } = useGetAdviceQuery();
  const [generate, { isLoading: generating }] = useGenerateAdviceMutation();

  async function runAdvice() {
    try {
      await generate().unwrap();
    } catch (e) {
      const msg = (e as { data?: { error?: string } })?.data?.error ?? String(e);
      toast.error(msg.includes("not set") ? "AI-ключ не налаштовано на цьому середовищі." : "Не вдалося отримати поради. Спробуй ще раз.");
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
              <Metric label="Витрати / міс" v={<Money minor={advice.monthly_burn} decimals={false} />} />
              <Metric label="Подушки вистачить на" v={months != null ? `${Math.max(0, months)} міс` : "—"} tone={tone}
                info="Ліквідна подушка ÷ середні місячні витрати. Скільки протягнеш на реальні кошти за поточного темпу." />
            </div>
            {advice.runway_comment && <p className="runway-comment" style={{ gridColumn: "1 / -1" }}>{highlightAmounts(advice.runway_comment)}</p>}
          </div>
        )}

        <div className="advisor-grid single">
          {/* Структуровані поради + інсайт */}
          <div className="stack" style={{ gap: 18 }}>
            <section>
              <div className="section-head">
                <h2>Поради на твоїх числах</h2>
                <button className="btn primary" style={{ padding: "7px 14px" }} onClick={runAdvice} disabled={generating}>
                  {generating ? "Аналізую…" : advice ? "Оновити" : "Отримати"}
                </button>
              </div>

              {advice?.suggestions?.length ? (
                <div className="stack">
                  {advice.summary && <p className="ai-text" style={{ margin: "0 2px 6px" }}>{renderRich(advice.summary)}</p>}
                  {advice.facts && advice.facts.length > 0 && (
                    <div className="card" style={{ padding: 16 }}>
                      <RichFacts facts={advice.facts} />
                    </div>
                  )}
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
              ) : (
                <div className="card empty">Натисни «Отримати» — AI врахує твої числа, цілі й профіль із Налаштувань.</div>
              )}
            </section>

            <AiInsightCard days={30} />
            <AdviceHistory />
          </div>
        </div>
      </div>
    </>
  );
}

// §2: історія порад — компактні знімки (runway/burn) у часі, щоб бачити траєкторію.
function AdviceHistory() {
  const { data: hist } = useGetAdviceHistoryQuery();
  if (!hist || hist.length < 2) return null;
  const dfmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "short" });
  return (
    <section>
      <div className="section-head"><h2>Історія порад</h2><span className="label">як мінялися числа</span></div>
      <div className="card" style={{ padding: 8 }}>
        {hist.map((h, i) => (
          <div key={i} className="adv-hist-row">
            <span className="adv-hist-date">{dfmt.format(h.generated_at * 1000)}</span>
            <span className="adv-hist-sum">{h.summary || "—"}</span>
            <span className="adv-hist-nums">
              {h.runway_months != null && <>runway <b>{h.runway_months}м</b> · </>}
              burn <b><Money minor={h.monthly_burn} decimals={false} /></b>/міс
            </span>
          </div>
        ))}
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
      className="btn primary" style={{ marginTop: 10, padding: "6px 12px", fontSize: 13 }}
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
