import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  useChatAdviceMutation,
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
import { renderMarkdown } from "../lib/markdown.tsx";
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
          <div className="sub">AI дивиться на твої числа й радить. Запитай або опиши, що тобі треба.</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        {advice && (
          <div className="card runway-card">
            <Gauge
              ratio={months != null ? months / 12 : 0}
              center={months != null ? String(months) : "—"}
              sub={months != null ? "місяців" : "нема даних"}
              tone={tone}
            />
            <div className="runway-metrics">
              <Metric label="Власні кошти" v={<Money minor={advice.own_funds} decimals={false} />} />
              <Metric label="Витрати / міс" v={<Money minor={advice.monthly_burn} decimals={false} />} />
              <Metric label="Вистачить на" v={months != null ? `${months} міс` : "—"} tone={tone} />
              {advice.runway_comment && <p className="runway-comment">{highlightAmounts(advice.runway_comment)}</p>}
            </div>
          </div>
        )}

        <div className="advisor-grid">
          {/* Ліва колонка: інтерактивний радник (питай / описуй) */}
          <AdvisorAsk />

          {/* Права колонка: структуровані поради + інсайт */}
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

type Msg = { role: "user" | "assistant"; content: string };
const ASK_KEY = "mt-advisor-ask";
const ASK_SUGGESTIONS = [
  "Розбери, куди в мене втікають гроші, і що з цим робити",
  "Скільки я реально можу відкладати щомісяця?",
  "Проаналізуй мої підписки — що зайве?",
  "Я хочу зібрати на відпустку 40 000 ₴ за пів року. Реально?",
];

function loadAsk(): Msg[] {
  try { const raw = localStorage.getItem(ASK_KEY); return raw ? (JSON.parse(raw) as Msg[]) : []; } catch { return []; }
}

// Інлайн-порадник: питай своїми словами або опиши задачу — детальна відповідь (Sonnet 5).
// Історія локально; профіль і числа AI бачить сам (сервер підмішує). Це не дублює профіль.
function AdvisorAsk() {
  const [chat, { isLoading }] = useChatAdviceMutation();
  const [messages, setMessages] = useState<Msg[]>(loadAsk);
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    try { localStorage.setItem(ASK_KEY, JSON.stringify(messages.slice(-60))); } catch { /* ignore */ }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || isLoading || sending.current) return;
    sending.current = true;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    try {
      const res = await chat({ messages: next, attachedTxIds: [] }).unwrap();
      if (mounted.current) setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
    } catch {
      if (mounted.current) setMessages((m) => [...m, { role: "assistant", content: "Не вдалося відповісти. Спробуй ще раз." }]);
    } finally { sending.current = false; }
  }

  return (
    <section className="advisor-ask">
      <div className="section-head">
        <h2>Запитай або опиши, що треба</h2>
        {messages.length > 0 && (
          <button className="btn ghost" style={{ padding: "4px 10px" }}
            onClick={() => { setMessages([]); try { localStorage.removeItem(ASK_KEY); } catch { /* ignore */ } }}>
            Очистити
          </button>
        )}
      </div>
      <div className="card advisor-ask-card">
        <div className="advisor-ask-log" ref={logRef}>
          {messages.length === 0 ? (
            <div className="advisor-ask-empty">
              <p>Опиши задачу своїми словами — AI бачить твої числа й профіль, і відповість детально.</p>
              <div className="chat-suggest">
                {ASK_SUGGESTIONS.map((s) => (
                  <button key={s} className="chat-chip" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>{renderMarkdown(m.content)}</div>
            ))
          )}
          {isLoading && <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>}
        </div>
        <div className="advisor-ask-input">
          <input
            placeholder="напр. «як мені за 3 місяці зменшити витрати на 20%?»"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          />
          <button className="btn primary" onClick={() => send()} disabled={isLoading || !input.trim()} aria-label="Надіслати">➤</button>
        </div>
      </div>
      <Link to="/chat" className="advisor-ask-more">Відкрити повний чат (з прикріпленням операцій) →</Link>
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

function Metric({ label, v, tone }: { label: string; v: React.ReactNode; tone?: string }) {
  return (
    <div className="runway-metric">
      <div className="label">{label}</div>
      <div className={`runway-val num-hero ${tone === "pos" ? "pos" : tone === "neg" ? "neg" : tone === "warn" ? "" : ""}`}>{v}</div>
    </div>
  );
}
