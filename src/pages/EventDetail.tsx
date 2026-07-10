import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGetEventQuery, useEvaluateGroupMutation, useChatGroupMutation } from "../store/api.ts";
import type { StructuredInsight, TxRow } from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { Icon } from "../components/Icon.tsx";
import { TransactionList } from "../components/TransactionList.tsx";
import { GROUP_KINDS } from "../components/GroupModal.tsx";
import { renderMarkdown } from "../lib/markdown.tsx";
import { toast } from "../lib/toast.ts";

const kindLabel = (k: string | null) => GROUP_KINDS.find((x) => x.value === k)?.label ?? "Група";

// Деталь групи: зліва підсумок + транзакції, справа — AI-панель (оцінка групи + чат по ній).
export function EventDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useGetEventQuery(Number(id), { skip: !id });

  if (isLoading) return <div className="empty">Завантаження…</div>;
  if (!data?.event) return <div className="card empty">Групу не знайдено.</div>;

  const { event, transactions } = data;
  const uah = transactions.filter((t) => t.currency_code === 980);
  const spent = uah.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const income = uah.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const color = event.color ?? "var(--accent)";

  return (
    <>
      <div className="section-head">
        <button className="btn ghost" style={{ padding: "4px 8px", marginLeft: -8 }} onClick={() => navigate(-1)}>← назад</button>
      </div>

      <div className="card group-detail-head" style={{ "--group-color": color } as React.CSSProperties}>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <span className="group-ico" style={{ background: color }}><Icon name="folder" size={20} /></span>
          <div>
            <div className="greet" style={{ fontSize: 22 }}>{event.name}</div>
            <div className="sub">{kindLabel(event.kind)} · {transactions.length} операцій</div>
          </div>
        </div>
        {event.note && <p className="group-detail-note">{event.note}</p>}
        <div className="group-detail-stats">
          <div><div className="label">витрачено</div><div className="num-hero" style={{ fontSize: 24 }}><Money minor={spent} decimals={false} /></div></div>
          {income > 0 && <div><div className="label">надійшло</div><div className="num-hero pos" style={{ fontSize: 24 }}><Money minor={income} decimals={false} /></div></div>}
        </div>
      </div>

      <div className="evt-grid">
        <div>
          <div className="section-head" style={{ marginTop: 18 }}><h2>Транзакції групи</h2></div>
          <TransactionList rows={transactions as TxRow[]} />
        </div>
        <div>
          <div className="section-head" style={{ marginTop: 18 }}><h2>AI про групу</h2></div>
          <GroupAiPanel eventId={Number(id)} groupName={event.name} />
        </div>
      </div>
    </>
  );
}

type Msg = { role: "user" | "assistant"; content: string };

function GroupAiPanel({ eventId, groupName }: { eventId: number; groupName: string }) {
  const [evaluate, { isLoading: evaluating }] = useEvaluateGroupMutation();
  const [chatGroup, { isLoading: chatting }] = useChatGroupMutation();
  const [evalResult, setEvalResult] = useState<StructuredInsight | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const sending = useRef(false);

  async function runEval() {
    try { setEvalResult(await evaluate(eventId).unwrap()); }
    catch (e) { toast.error(String(e)); }
  }

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || chatting || sending.current) return;
    sending.current = true;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    try {
      const r = await chatGroup({ id: eventId, messages: next }).unwrap();
      setMessages((m) => [...m, { role: "assistant", content: r.reply }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Не вдалося відповісти. Спробуй ще раз." }]);
    } finally { sending.current = false; }
  }

  return (
    <div className="card grp-ai">
      <p className="grp-ai-hint">AI оцінить цю групу — скільки коштувала, як вдарила по бюджету, чи дорого — і відповість на питання саме про неї.</p>
      <button className="btn primary" style={{ width: "100%" }} disabled={evaluating} onClick={runEval}>
        {evaluating ? "Аналізую…" : evalResult ? "✨ Оцінити ще раз" : "✨ Оцінити групу"}
      </button>

      {evalResult && (
        <div className="grp-eval">
          <div className="grp-eval-head">{renderMarkdown(evalResult.headline)}</div>
          <div className="grp-eval-facts">
            {(evalResult.facts ?? []).map((f, i) => (
              <div key={i} className="grp-fact">
                <span className={`grp-fact-dot ${f.tone ?? "neutral"}`} />
                <span className="grp-fact-label">{renderMarkdown(f.label)}</span>
                {f.amount != null && <span className="grp-fact-amt">{f.amount.toLocaleString("uk-UA")} ₴</span>}
              </div>
            ))}
          </div>
          {evalResult.note && <div className="grp-eval-note">💡 {renderMarkdown(evalResult.note)}</div>}
        </div>
      )}

      <div className="grp-chat">
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === "assistant" ? renderMarkdown(m.content) : m.content}
          </div>
        ))}
        {chatting && <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>}
      </div>

      <div className="grp-chat-input">
        <input placeholder={`Спитати про «${groupName}»…`} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        <button className="btn primary" onClick={() => send()} disabled={chatting || !input.trim()} aria-label="Надіслати">➤</button>
      </div>
    </div>
  );
}
