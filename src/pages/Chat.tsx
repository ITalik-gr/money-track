import { useEffect, useRef, useState } from "react";
import { useChatAdviceMutation, useGetTransactionsQuery } from "../store/api.ts";
import { renderMarkdown } from "../lib/markdown.tsx";

type Msg = { role: "user" | "assistant"; content: string };
type Attached = { id: string; label: string };
const sign = (c: number) => (c === 840 ? "$" : c === 978 ? "€" : "₴");
const STORE_KEY = "mt-chat";

const SUGGESTIONS = [
  "На чому мені зекономити цього місяця?",
  "Чи нормальні мої витрати на кафе?",
  "Скільки я можу відкладати щомісяця?",
  "Проаналізуй мої підписки",
];

function load(): Msg[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Msg[]) : [];
  } catch { return []; }
}

// Окрема сторінка чату з AI-порадником: лог зверху, інпут знизу, історія локально
// (localStorage), сервер бере останні ходи (stateless). Стійкий до переходу зі сторінки
// під час запиту: якщо відповідь не дійшла — показуємо «надіслати ще раз».
export function Chat() {
  const [chat, { isLoading }] = useChatAdviceMutation();
  const [messages, setMessages] = useState<Msg[]>(load);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pquery, setPquery] = useState("");
  const { data: picks = [] } = useGetTransactionsQuery({ q: pquery.trim() || undefined, limit: 8 }, { skip: !pickerOpen });
  const logRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false); // синхронний замок від подвійного надсилання (Enter + клік)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-100))); } catch { /* ignore */ }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  // Відповідь ще не дійшла (останнє — питання юзера), і зараз не вантажимо → пропонуємо повтор.
  const awaitingReply = messages.length > 0 && messages[messages.length - 1].role === "user" && !isLoading;

  async function ask(history: Msg[], attachedTxIds: string[]) {
    try {
      const res = await chat({ messages: history, attachedTxIds }).unwrap();
      if (mounted.current) setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
    } catch {
      if (mounted.current) setMessages((m) => [...m, { role: "assistant", content: "Не вдалося відповісти. Спробуй ще раз." }]);
    }
  }

  function addAttach(a: Attached) {
    setAttached((prev) => prev.some((x) => x.id === a.id) ? prev : [...prev, a]);
    setPickerOpen(false); setPquery("");
  }

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || isLoading || sending.current) return;
    sending.current = true;
    const ids = attached.map((a) => a.id);
    // Прикріплені операції показуємо в тексті питання як чипи (щоб залишились у логу).
    const withRefs = attached.length ? `${q}\n${attached.map((a) => `[tx:${a.id}|${a.label}]`).join(" ")}` : q;
    const next: Msg[] = [...messages, { role: "user", content: withRefs }];
    setMessages(next);
    setInput("");
    setAttached([]);
    try { await ask(next, ids); } finally { sending.current = false; }
  }

  function retry() {
    if (isLoading || !awaitingReply) return;
    void ask(messages, []);
  }

  function clear() {
    setMessages([]);
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  }

  return (
    <div className="chat-page">
      <div className="page-head">
        <div>
          <div className="greet">Чат з AI</div>
          <div className="sub">Питай про свої гроші — AI бачить твої числа, категорії та групи.</div>
        </div>
        {messages.length > 0 && (
          <div className="page-head-actions">
            <button className="btn ghost" onClick={clear}>Очистити</button>
          </div>
        )}
      </div>

      <div className="chat-shell">
        <div className="chat-log2" ref={logRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <p>Постав перше запитання або обери підказку:</p>
              <div className="chat-suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chat-chip" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                {renderMarkdown(m.content)}
              </div>
            ))
          )}
          {isLoading && (
            <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>
          )}
          {awaitingReply && (
            <button className="chat-retry" onClick={retry}>Відповідь не дійшла — надіслати ще раз ↻</button>
          )}
        </div>

        {(attached.length > 0 || pickerOpen) && (
          <div className="chat-attach">
            {attached.map((a) => (
              <span key={a.id} className="tx-chip static">{a.label}
                <button className="chip-x" onClick={() => setAttached((p) => p.filter((x) => x.id !== a.id))} aria-label="Прибрати">×</button>
              </span>
            ))}
            {pickerOpen && (
              <div className="chat-picker">
                <input autoFocus placeholder="пошук операції для прикріплення…" value={pquery} onChange={(e) => setPquery(e.target.value)} />
                <div className="chat-picker-list">
                  {picks.slice(0, 8).map((t) => (
                    <button key={t.id} className="chat-picker-row"
                      onClick={() => addAttach({ id: t.id, label: `${(t.merchant || t.comment || "операція").slice(0, 22)} ${Math.round(t.amount / 100)}${sign(t.currency_code)}` })}>
                      <span className="cp-name">{t.merchant || t.comment || "операція"}</span>
                      <span className="cp-amt">{Math.round(t.amount / 100)} {sign(t.currency_code)}</span>
                    </button>
                  ))}
                  {!picks.length && <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>Нічого не знайдено.</div>}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="chat-input">
          <button className="chat-attach-btn" onClick={() => setPickerOpen((o) => !o)} aria-label="Прикріпити операцію" title="Прикріпити операцію">＋</button>
          <input
            autoFocus
            placeholder="напр. «на чому мені зекономити цього місяця?»"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          />
          <button className="btn primary" onClick={() => send()} disabled={isLoading || !input.trim()} aria-label="Надіслати">➤</button>
        </div>
      </div>
    </div>
  );
}
