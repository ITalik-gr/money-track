import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChatAdviceMutation, useGetTransactionsQuery } from "../store/api.ts";
import { renderMarkdown } from "../lib/markdown.tsx";
import { Icon } from "../components/Icon.tsx";

type Msg = { role: "user" | "assistant"; content: string };
type Attached = { id: string; label: string };
type Convo = { id: string; title: string; messages: Msg[]; updatedAt: number };
const sign = (c: number) => (c === 840 ? "$" : c === 978 ? "€" : "₴");
const STORE_KEY = "mt-chats";

const SUGGESTIONS = [
  "Проаналізуй мою ситуацію як фінменеджер",
  "Куди зараз краще спрямувати гроші?",
  "На чому мені зекономити цього місяця?",
  "Що платити першим, а що почекає?",
];

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emptyConvo = (): Convo => ({ id: newId(), title: "Нова розмова", messages: [], updatedAt: Date.now() });

// Заголовок розмови = перше питання користувача (обрізане), очищене від чипів-операцій.
function titleFrom(text: string): string {
  const clean = text.replace(/\[tx:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 40) : "Нова розмова";
}

function load(): Convo[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Convo[];
      if (Array.isArray(arr) && arr.length) return arr;
    }
    // Міграція зі старого одиночного чату (`mt-chat`).
    const legacy = localStorage.getItem("mt-chat");
    if (legacy) {
      const msgs = JSON.parse(legacy) as Msg[];
      if (Array.isArray(msgs) && msgs.length) {
        const first = msgs.find((m) => m.role === "user");
        return [{ id: newId(), title: first ? titleFrom(first.content) : "Розмова", messages: msgs, updatedAt: Date.now() }];
      }
    }
  } catch { /* ignore */ }
  return [emptyConvo()];
}

// Окрема сторінка чату з AI-фінменеджером: рейл розмов ліворуч, лог + ввід праворуч.
// Кілька розмов у localStorage (сервер stateless — бере останні ходи однієї розмови).
// Стійка до переходу під час запиту: якщо відповідь не дійшла — «надіслати ще раз».
export function Chat() {
  const [chat, { isLoading }] = useChatAdviceMutation();
  const [convos, setConvos] = useState<Convo[]>(load);
  const [activeId, setActiveId] = useState<string>(() => convos[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pquery, setPquery] = useState("");
  const [railOpen, setRailOpen] = useState(false); // мобільна шухляда розмов
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const { data: picks = [] } = useGetTransactionsQuery({ q: pquery.trim() || undefined, limit: 8 }, { skip: !pickerOpen });

  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false); // синхронний замок від подвійного надсилання (Enter + клік)
  const pinTo = useRef<"user" | "bottom">("bottom"); // куди скролити після рендера
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const active = useMemo(() => convos.find((c) => c.id === activeId) ?? convos[0], [convos, activeId]);
  const messages = active?.messages ?? [];

  // Персист усіх розмов (обрізаємо історію кожної до 100 повідомлень).
  useEffect(() => {
    try {
      const trimmed = convos.map((c) => ({ ...c, messages: c.messages.slice(-100) }));
      localStorage.setItem(STORE_KEY, JSON.stringify(trimmed.slice(0, 40)));
    } catch { /* ignore */ }
  }, [convos]);

  // Скрол: після надсилання пінимо МОЄ повідомлення вгору в'юпорту (як ChatGPT),
  // щоб бачити питання + початок відповіді; в решті випадків — донизу.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    if (pinTo.current === "user" && lastUserRef.current) {
      log.scrollTo({ top: lastUserRef.current.offsetTop - 12, behavior: "smooth" });
    } else {
      log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isLoading]);

  // Автовисота textarea під контент (до ~7 рядків); скролбар з'являється ЛИШЕ на максимумі.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const h = Math.min(ta.scrollHeight, 160);
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);

  const awaitingReply = messages.length > 0 && messages[messages.length - 1].role === "user" && !isLoading;

  const setMessages = useCallback((updater: (m: Msg[]) => Msg[]) => {
    setConvos((prev) => prev.map((c) => c.id === activeId ? { ...c, messages: updater(c.messages), updatedAt: Date.now() } : c));
  }, [activeId]);

  async function ask(history: Msg[], attachedTxIds: string[]) {
    try {
      const res = await chat({ messages: history, attachedTxIds }).unwrap();
      if (mounted.current) { pinTo.current = "user"; setMessages((m) => [...m, { role: "assistant", content: res.reply }]); }
    } catch {
      if (mounted.current) { pinTo.current = "bottom"; setMessages((m) => [...m, { role: "assistant", content: "Не вдалося відповісти. Спробуй ще раз." }]); }
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
    const withRefs = attached.length ? `${q}\n${attached.map((a) => `[tx:${a.id}|${a.label}]`).join(" ")}` : q;
    const next: Msg[] = [...messages, { role: "user", content: withRefs }];
    pinTo.current = "user";
    // Перше повідомлення розмови → задаємо заголовок.
    setConvos((prev) => prev.map((c) => c.id === activeId
      ? { ...c, messages: next, title: c.messages.length === 0 ? titleFrom(q) : c.title, updatedAt: Date.now() }
      : c));
    setInput("");
    setAttached([]);
    try { await ask(next, ids); } finally { sending.current = false; }
  }

  function retry() {
    if (isLoading || !awaitingReply) return;
    pinTo.current = "bottom";
    void ask(messages, []);
  }

  // Регенерація: викидаємо останню відповідь AI й перепитуємо на тій самій історії.
  function regenerate() {
    if (isLoading || sending.current) return;
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
    if (lastUser === -1) return;
    const history = messages.slice(0, lastUser + 1);
    setMessages(() => history);
    pinTo.current = "bottom";
    void ask(history, []);
  }

  async function copyMsg(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text.replace(/\[tx:[^|\]]+\|([^\]]+)\]/g, "$1"));
      setCopiedIdx(idx);
      setTimeout(() => { if (mounted.current) setCopiedIdx((c) => (c === idx ? null : c)); }, 1400);
    } catch { /* clipboard недоступний */ }
  }

  function newChat() {
    const c = emptyConvo();
    setConvos((prev) => [c, ...prev]);
    setActiveId(c.id);
    setInput(""); setAttached([]); setRailOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  function openChat(id: string) {
    setActiveId(id); setRailOpen(false); setInput(""); setAttached([]);
  }

  function deleteChat(id: string) {
    setConvos((prev) => {
      const rest = prev.filter((c) => c.id !== id);
      const next = rest.length ? rest : [emptyConvo()];
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  }

  const lastAssistantIdx = (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i; return -1; })();
  const sortedConvos = useMemo(() => [...convos].sort((a, b) => b.updatedAt - a.updatedAt), [convos]);

  return (
    <div className={`chat-layout ${railOpen ? "rail-open" : ""}`}>
      {/* Рейл розмов */}
      <aside className="chat-rail">
        <button className="btn primary chat-new" onClick={newChat}><Icon name="plus" size={15} />Нова розмова</button>
        <div className="chat-rail-list">
          {sortedConvos.map((c) => (
            <div key={c.id} className={`chat-rail-item ${c.id === activeId ? "active" : ""}`} onClick={() => openChat(c.id)}>
              <span className="cri-title">{c.title}</span>
              <button className="cri-del" aria-label="Видалити розмову" title="Видалити"
                onClick={(e) => { e.stopPropagation(); deleteChat(c.id); }}>×</button>
            </div>
          ))}
        </div>
      </aside>
      {railOpen && <div className="chat-rail-scrim" onClick={() => setRailOpen(false)} />}

      {/* Основна колонка */}
      <div className="chat-page">
        <div className="page-head chat-head">
          <button className="chat-rail-toggle" aria-label="Розмови" onClick={() => setRailOpen(true)}><Icon name="menu" size={18} /></button>
          <div>
            <div className="greet">Чат з AI</div>
            <div className="sub">Особистий фінменеджер — бачить усі твої числа, рахунки, підписки й бюджети.</div>
          </div>
          <div className="page-head-actions">
            <button className="btn ghost sm" onClick={newChat}><Icon name="plus" size={14} />Нова</button>
          </div>
        </div>

        <div className="chat-shell">
          <div className="chat-log2" ref={logRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                <p>Спитай будь-що про свої гроші — відповім на твоїх реальних числах:</p>
                <div className="chat-suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chat-chip" onClick={() => send(s)}>{s}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => {
                const isLastUser = m.role === "user" && i === messages.length - 1;
                return (
                  <div key={i} className={`chat-msg-wrap ${m.role}`} ref={isLastUser ? lastUserRef : undefined}>
                    <div className={`chat-msg ${m.role}`}>{renderMarkdown(m.content)}</div>
                    {m.role === "assistant" && m.content && (
                      <div className="chat-msg-actions">
                        <button onClick={() => copyMsg(m.content, i)} title="Копіювати">
                          <Icon name={copiedIdx === i ? "check" : "copy"} size={13} />{copiedIdx === i ? "Скопійовано" : "Копіювати"}
                        </button>
                        {i === lastAssistantIdx && !isLoading && (
                          <button onClick={regenerate} title="Перегенерувати"><Icon name="repeat" size={13} />Ще раз</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
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
            <textarea
              ref={taRef}
              rows={1}
              autoFocus
              placeholder="напр. «куди зараз краще спрямувати гроші?»  (Enter — надіслати, Shift+Enter — новий рядок)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="btn primary chat-send" onClick={() => send()} disabled={isLoading || !input.trim()} aria-label="Надіслати">➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}
