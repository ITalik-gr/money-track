import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import {
  api, useGetMeQuery, useGetTransactionsQuery, useGetChatsQuery, useGetChatQuery,
  useDeleteChatMutation, useAppendChatMessageMutation, useTruncateChatMutation, useImportChatsMutation,
} from "../store/api.ts";
import { renderMarkdown, trimIncompleteBlocks } from "../lib/markdown.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { errText } from "../lib/errors.ts";
import { streamChat } from "../lib/aiStream.ts";
import { useT, translate } from "../i18n/index.ts";
import { getLocale } from "../i18n/locale.ts";

type Msg = { role: "user" | "assistant"; content: string };
type Attached = { id: string; label: string };
const sign = (c: number) => (c === 840 ? "$" : c === 978 ? "€" : "₴");

const SUGGESTION_KEYS = ["chat.suggest1", "chat.suggest2", "chat.suggest3", "chat.suggest4"] as const;

/**
 * How the streamed answer is paced onto the screen (see `ask`).
 *
 * A frame reveals `pending / REVEAL_SHARE` characters, so the backlog drains exponentially: 6 at
 * 60fps empties a burst in about a tenth of a second — fast enough that nothing feels held back,
 * even in tone with what came before it. Lower is jumpier, higher visibly lags the model.
 *
 * `MIN_REVEAL` is the floor. Without it the tail of an answer creeps out a character per frame
 * (`ceil(1/6)` is 1), and the last few words are exactly where the reader is watching hardest.
 */
const REVEAL_SHARE = 6;
const MIN_REVEAL = 3;

// Id-и генерує КЛІЄНТ: стрічка розмов має показати нову розмову в мить кліку, задовго до того, як
// сервер щось відповість. Форма звужена до `[A-Za-z0-9_-]`, бо саме її перевіряє роут.
const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Заголовок розмови = перше питання користувача (обрізане), очищене від чипів-операцій.
function titleFrom(text: string): string {
  const clean = text.replace(/\[tx:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 40) : translate(getLocale(), "chat.newConvo");
}

/**
 * Разова міграція розмов, що лишились у localStorage (§CHAT-SYNC).
 *
 * Ключі вичищаються ЛИШЕ після того, як сервер підтвердив імпорт — інакше невдалий запит стер би
 * єдину копію листування. Імпорт ідемпотентний за id, тож другий пристрій дозаллє своє й не
 * подвоїть спільне.
 */
const LOCAL_KEYS = (scope: string) => [`mt-chats:${scope}`, "mt-chats", "mt-chat"];
function readLocalChats(scope: string): { keys: string[]; chats: unknown[] } {
  const keys: string[] = [];
  const chats: unknown[] = [];
  for (const key of LOCAL_KEYS(scope)) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { return { keys: [], chats: [] }; }
    if (!raw) continue;
    keys.push(key);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.length) continue;
      // `mt-chat` — найдавніша форма: просто масив повідомлень без обгортки розмови.
      if (key === "mt-chat") chats.push({ id: newId(), title: translate(getLocale(), "chat.convoFallback"), updated_at: Date.now(), messages: parsed });
      else chats.push(...parsed);
    } catch { /* зіпсований JSON — ключ усе одно приберемо */ }
  }
  return { keys, chats };
}

// Окрема сторінка чату з AI-фінменеджером: рейл розмов ліворуч, лог + ввід праворуч.
//
// §CHAT-SYNC (2026-08-07): розмови живуть НА СЕРВЕРІ (`/api/chats`), у власному Durable Object
// користувача. Доти вони лежали в localStorage — тобто розмова існувала лише на тому пристрої, де
// її набрали, і питання з телефона не було на ноутбуці. Локальний стан тут лишився рівно один:
// повідомлення, яке зараз пишеться (його ще нема в базі, бо воно ще не дописане).
export function Chat() {
  const tr = useT();
  const dispatch = useDispatch();
  // Відповідь стрімиться (`lib/aiStream.ts`), тож «зайнято» тримає власний стан, а не RTK Query:
  // у мутації два стани («летить» / «прийшло»), а вся суть тут — у проміжних.
  const [streaming, setStreaming] = useState(false);
  // Чи вже пішов ТЕКСТ. Три різні стани, які раніше були одним: чекаємо першого слова (крапки),
  // текст іде (без прикрас), готово. Крапки під уже написаною відповіддю читались би як друга
  // відповідь, що зараз почнеться.
  const [streamStarted, setStreamStarted] = useState(false);
  const isLoading = streaming;
  const { data: me } = useGetMeQuery();
  const { data: chats = [] } = useGetChatsQuery();
  const [activeId, setActiveId] = useState<string>("");
  // Порожня розмова, якої ще нема на сервері: рядок у базі без жодного повідомлення — привид,
  // який поїхав би на всі пристрої й пережив би того, хто передумав питати.
  const [draftId, setDraftId] = useState<string>(() => newId());
  // Питаємо про розмову лише коли СЕРВЕР про неї вже знає (вона є у стрічці). Інакше перший запит
  // після відправлення першого питання летів би раніше, ніж рядок створено, і 404 показався б
  // читачеві тостом «не знайдено» рівно в мить, коли все працює як слід.
  const known = chats.some((c) => c.id === activeId);
  const { data: openChatData } = useGetChatQuery(activeId, { skip: !activeId || !known });
  /**
   * Оптимістична копія розмови на час обміну.
   *
   * Сервер знає про хід користувача після `appendChatMessage`, а про відповідь — аж коли вона
   * дописана. Між цими двома моментами екран мусить показувати те, що відбувається, тож поки
   * `live` не порожній, він і є джерелом для рендера. Знімається, щойно серверна копія його
   * наздогнала (ефект нижче), — не за таймером.
   */
  const [live, setLive] = useState<{ id: string; messages: Msg[] } | null>(null);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pquery, setPquery] = useState("");
  const [railOpen, setRailOpen] = useState(false); // мобільна шухляда розмов
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const { data: picks = [] } = useGetTransactionsQuery({ q: pquery.trim() || undefined, limit: 8 }, { skip: !pickerOpen });

  const [appendMessage] = useAppendChatMessageMutation();
  const [truncateChat] = useTruncateChatMutation();
  const [deleteChatReq] = useDeleteChatMutation();
  const [importChats] = useImportChatsMutation();

  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false); // синхронний замок від подвійного надсилання (Enter + клік)
  const pinTo = useRef<"user" | "bottom" | "none">("bottom"); // куди скролити після рендера
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const messages: Msg[] = live && live.id === activeId
    ? live.messages
    : (activeId && openChatData?.id === activeId ? openChatData.messages : []);

  // Перший вхід на сторінку: відкрити найсвіжішу розмову, а якщо їх немає — чернетку.
  useEffect(() => {
    if (activeId) return;
    setActiveId(chats.length ? chats[0].id : draftId);
  }, [chats, activeId, draftId]);

  // Разова міграція локальних розмов. Не для демо: пісочниця живе добу, а localStorage браузера
  // спільний для всіх демо-візитів — це затягло б у неї чужі розмови з того самого браузера.
  const importedRef = useRef(false);
  useEffect(() => {
    const scope = me?.user?.id;
    if (!scope || me?.demo || importedRef.current) return;
    const { keys, chats: local } = readLocalChats(scope);
    if (!keys.length) return;
    importedRef.current = true;
    void (async () => {
      try {
        if (local.length) await importChats({ chats: local }).unwrap();
        for (const k of keys) localStorage.removeItem(k);
      } catch { importedRef.current = false; /* спробуємо наступного разу — копія ще на місці */ }
    })();
  }, [me?.user?.id, me?.demo, importChats]);

  // Оптимістична копія віддає екран серверній, щойно та її наздогнала. Порівняння за ДОВЖИНОЮ,
  // а не за вмістом: сервер зберігає рівно те, що показано, тож коли ходів стільки ж — це воно.
  useEffect(() => {
    if (!live || streaming) return;
    if (openChatData?.id === live.id && openChatData.messages.length >= live.messages.length) setLive(null);
  }, [openChatData, live, streaming]);

  // Скрол: після надсилання пінимо МОЄ повідомлення вгору в'юпорту (як ChatGPT),
  // щоб бачити питання + початок відповіді; в решті випадків — донизу.
  //
  // ⚠️ Під час стріму цей ефект спрацьовує на КОЖНОМУ кадрі тексту, і саме він давав ривки:
  // `behavior:"smooth"` запускає власну анімацію прокрутки, а наступний кадр за 16 мс перериває її
  // й починає нову — виходить не плавний рух, а посмикування.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    if (pinTo.current === "none") return;
    if (pinTo.current === "user" && lastUserRef.current) {
      log.scrollTo({ top: lastUserRef.current.offsetTop - 12, behavior: streamStarted ? "auto" : "smooth" });
      // Пін робиться ОДИН раз — щойно пішов текст. Далі відповідь росте під питанням, а скрол
      // належить читачеві: якщо він відгортає вгору перечитати абзац, наступний кадр не має права
      // повернути його вниз.
      if (streamStarted) pinTo.current = "none";
      return;
    }
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, streamStarted]);

  // Автовисота textarea під контент (до ~7 рядків); скролбар з'являється ЛИШЕ на максимумі.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    // ⚠️ Порожнє поле НЕ міряємо. У WebKit (iPhone) `scrollHeight` враховує ПЛЕЙСХОЛДЕР, а на
    // вузькому екрані він переноситься на чотири рядки — тобто порожній ввід відкривався
    // висотою в абзац, хоч `rows={1}`. `height:auto` лишає власну висоту одного рядка з CSS.
    if (!input) { ta.style.overflowY = "hidden"; return; }
    const h = Math.min(ta.scrollHeight, 160);
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);

  const awaitingReply = messages.length > 0 && messages[messages.length - 1].role === "user" && !isLoading;

  const putLive = useCallback((id: string, updater: (m: Msg[]) => Msg[]) => {
    setLive((prev) => ({ id, messages: updater(prev && prev.id === id ? prev.messages : []) }));
  }, []);

  /**
   * Питання → відповідь, що ТЕЧЕ.
   *
   * Порожнє повідомлення асистента додається ОДРАЗУ й наповнюється дельтами. Це і є вся різниця
   * для читача: перші слова зʼявляються за секунду, а не через півхвилини мовчання, протягом якої
   * застосунок виглядав завислим поруч із будь-яким іншим AI-продуктом.
   *
   * Реф-накопичувач, а не стан: дельти приходять десятками за секунду, і читати «попереднє
   * значення» зі стану в кожній з них означало б гонку з батчингом React.
   *
   * ⚠️ Рендер прив'язаний до КАДРУ, а не до дельти. Модель шле дельти нерівно — то по літері, то
   * абзацом, — і рендер на кожній означав і зайві перемальовування markdown, і текст, що
   * з'являється ривками в темпі мережі. `requestAnimationFrame` зводить усе, що прийшло між
   * кадрами, в одне оновлення: та сама швидкість, але рівний темп.
   *
   * ⚠️ Frame pacing alone was not enough, and this is why (the reported complaint: the words do not
   * appear smoothly). A frame showed EVERYTHING that had arrived since the previous one, so the
   * jitter simply moved from the delta to the frame: one frame added a character, the next dumped
   * a whole paragraph. What the reader sees as smooth is a steady rate, not a bounded interval.
   * So the frame now reveals a SHARE of the backlog (`REVEAL_SHARE`) instead of all of it, which
   * drains bursts exponentially — visually immediate, never in lumps — and the arrival rate only
   * sets how full the buffer is, not how the text lands.
   *
   * ⚠️ Хід асистента в базу пише СЕРВЕР (див. роут `/advisor/chat/stream`), а не цей код: інакше
   * закрита посеред відповіді вкладка забирала б її з собою.
   */
  async function ask(chatId: string, history: Msg[], attachedTxIds: string[]) {
    // `text` — everything received; `shown` — how much of it has been drawn.
    const acc = { text: "", shown: 0 };
    let opened = false;
    let frame = 0;
    const put = (content: string) => putLive(chatId, (m) => {
      const next = [...m];
      if (opened && next.length && next[next.length - 1].role === "assistant") next[next.length - 1] = { role: "assistant", content };
      else { next.push({ role: "assistant", content }); opened = true; }
      return next;
    });
    const flush = () => {
      frame = 0;
      const pending = acc.text.length - acc.shown;
      if (pending <= 0) return;
      // A share of the backlog, with a floor so a one-character tail still lands next frame. The
      // floor also keeps the very first words fast: at that point the backlog is tiny, and a pure
      // share would trickle them out one letter at a time.
      acc.shown = Math.min(acc.text.length, acc.shown + Math.max(MIN_REVEAL, Math.ceil(pending / REVEAL_SHARE)));
      put(acc.text.slice(0, acc.shown));
      // Re-arm while there is still buffered text: deltas arrive in bursts and then stop, so the
      // last burst would otherwise sit half-drawn until the next one pushed it out.
      if (acc.shown < acc.text.length) schedule();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    // Кадр, що спрацює ПІСЛЯ фінального тексту, перезаписав би повну відповідь накопиченою —
    // тобто відкотив би її на пів-речення назад.
    const cancel = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; } };

    setStreaming(true);
    setStreamStarted(false);
    try {
      await streamChat("/api/advisor/chat/stream", { messages: history, attachedTxIds, chat_id: chatId }, {
        onDelta: (chunk) => {
          acc.text += chunk;
          if (!mounted.current) return;
          // Пін на МОЄ питання лише при першій дельті: далі скрол мусить лишатись там, де його
          // поставив читач, інакше сторінка смикалась би на кожному слові.
          if (!opened) { pinTo.current = "user"; setStreamStarted(true); }
          schedule();
        },
        onDone: (reply) => { cancel(); if (mounted.current) put(reply); },
      });
      // Відповідь уже в базі — забираємо серверну копію (вона ж оновить стрічку розмов).
      dispatch(api.util.invalidateTags(["Chat"]));
    } catch (e) {
      cancel();
      // Реальна причина, не глухе «спробуй ще раз» (див. `lib/errors.ts`).
      const msg = tr("tx.chatReplyFailed", { error: errText(e) });
      if (mounted.current) {
        pinTo.current = "bottom";
        // Уже почали малювати відповідь → дописуємо помилку до неї, а не лишаємо обірваний
        // текст, який читається як закінчена думка.
        put(acc.text ? `${acc.text}\n\n${msg}` : msg);
      }
    } finally {
      cancel();
      if (mounted.current) { setStreaming(false); setStreamStarted(false); }
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
    const chatId = activeId || draftId;
    const ids = attached.map((a) => a.id);
    const withRefs = attached.length ? `${q}\n${attached.map((a) => `[tx:${a.id}|${a.label}]`).join(" ")}` : q;
    const next: Msg[] = [...messages, { role: "user", content: withRefs }];
    pinTo.current = "user";
    putLive(chatId, () => next);
    setActiveId(chatId);
    if (chatId === draftId) setDraftId(newId()); // чернетка стала справжньою розмовою
    setInput("");
    setAttached([]);
    try {
      // Хід користувача зберігається ДО виклику моделі: питання, після якого впала мережа, має
      // лишитись у розмові — саме на нього дивиться кнопка «надіслати ще раз».
      await appendMessage({ id: chatId, content: withRefs, title: titleFrom(q) }).unwrap().catch(() => {});
      await ask(chatId, next, ids);
    } finally { sending.current = false; }
  }

  function retry() {
    if (isLoading || !awaitingReply || !activeId) return;
    pinTo.current = "bottom";
    void ask(activeId, messages, []);
  }

  // Регенерація: викидаємо останню відповідь AI й перепитуємо на тій самій історії.
  async function regenerate() {
    if (isLoading || sending.current || !activeId) return;
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
    if (lastUser === -1) return;
    const history = messages.slice(0, lastUser + 1);
    putLive(activeId, () => history);
    pinTo.current = "bottom";
    // Обрізаємо і на сервері, інакше стара відповідь повернулась би з наступним оновленням
    // (і поїхала б на інший пристрій як така, що нібито ще актуальна).
    await truncateChat({ id: activeId, keep: history.length }).unwrap().catch(() => {});
    void ask(activeId, history, []);
  }

  async function copyMsg(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text.replace(/\[tx:[^|\]]+\|([^\]]+)\]/g, "$1"));
      setCopiedIdx(idx);
      setTimeout(() => { if (mounted.current) setCopiedIdx((c) => (c === idx ? null : c)); }, 1400);
    } catch { /* clipboard недоступний */ }
  }

  function newChat() {
    setActiveId(draftId);
    setLive(null);
    setInput(""); setAttached([]); setRailOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  function openChat(id: string) {
    setActiveId(id); setRailOpen(false); setInput(""); setAttached([]);
    setLive(null);
    pinTo.current = "bottom";
  }

  async function deleteChat(id: string) {
    const rest = chats.filter((c) => c.id !== id);
    if (id === activeId) { setActiveId(rest.length ? rest[0].id : draftId); setLive(null); }
    if (id === draftId) return;                 // чернетки на сервері нема — нічого видаляти
    await deleteChatReq(id).unwrap().catch(() => {});
  }

  const lastAssistantIdx = (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i; return -1; })();
  // Стрічка = розмови сервера; чернетка стоїть зверху лише поки вона відкрита й порожня.
  // Підпис чернетки береться через `tr`, а не з мемо: мемо не перерахувалось би при перемиканні
  // мови, і єдиний рядок стрічки лишився б попередньою мовою.
  const railItems: { id: string; title: string }[] = [
    ...(activeId === draftId ? [{ id: draftId, title: tr("chat.newConvo") }] : []),
    ...chats.map((c) => ({ id: c.id, title: c.title })),
  ];

  return (
    <div className={`chat-layout ${railOpen ? "rail-open" : ""}`}>
      {/* Рейл розмов */}
      <aside className="chat-rail">
        <button className="btn primary chat-new" onClick={newChat}><Icon name="plus" size={15} />{tr("chat.newConvo")}</button>
        <div className="chat-rail-list">
          {railItems.map((c) => (
            <div key={c.id} className={`chat-rail-item ${c.id === activeId ? "active" : ""}`} onClick={() => openChat(c.id)}>
              <span className="cri-title">{c.title}</span>
              <button className="cri-del" aria-label={tr("chat.deleteConvoAria")} title={tr("common.delete")}
                onClick={(e) => { e.stopPropagation(); void deleteChat(c.id); }}>×</button>
            </div>
          ))}
        </div>
      </aside>
      {railOpen && <div className="chat-rail-scrim" onClick={() => setRailOpen(false)} />}

      {/* Основна колонка */}
      <div className="chat-page">
        <div className="page-head chat-head">
          <button className="chat-rail-toggle" aria-label={tr("chat.convosAria")} onClick={() => setRailOpen(true)}><Icon name="menu" size={18} /></button>
          <div>
            <div className="greet">{tr("chat.title")}</div>
            <div className="sub">{tr("chat.sub")}</div>
            {/* A short answer in the demo is a BUDGET, not a shrug. Saying so is the difference
                between "this product gives thin answers" and "this is the sandbox's ceiling" —
                and the visitor has no other way to tell those apart. */}
            {me?.demo && <div className="chat-demo-note">{tr("chat.demoShort")}</div>}
          </div>
          <div className="page-head-actions">
            <button className="btn ghost sm" onClick={newChat}><Icon name="plus" size={14} />{tr("chat.newShort")}</button>
          </div>
        </div>

        <div className="chat-shell">
          <div className="chat-log2" ref={logRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                <p>{tr("chat.emptyPrompt")}</p>
                <div className="chat-suggest">
                  {SUGGESTION_KEYS.map((k) => (
                    <button key={k} className="chat-chip" onClick={() => send(tr(k))}>{tr(k)}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => {
                const isLastUser = m.role === "user" && i === messages.length - 1;
                // Повідомлення, яке ЗАРАЗ пишеться: половину блока (графік/таблицю) не малюємо,
                // поки він не закрився — див. `trimIncompleteBlocks`.
                const liveMsg = streamStarted && i === messages.length - 1 && m.role === "assistant";
                return (
                  <div key={i} className={`chat-msg-wrap ${m.role}`} ref={isLastUser ? lastUserRef : undefined}>
                    <div className={`chat-msg ${m.role}${liveMsg ? " live" : ""}`}>{renderMarkdown(liveMsg ? trimIncompleteBlocks(m.content) : m.content)}</div>
                    {m.role === "assistant" && m.content && (
                      <div className="chat-msg-actions">
                        <button onClick={() => copyMsg(m.content, i)} title={tr("tx.copy")}>
                          <Icon name={copiedIdx === i ? "check" : "copy"} size={13} />{copiedIdx === i ? tr("tx.copied") : tr("tx.copy")}
                        </button>
                        {i === lastAssistantIdx && !isLoading && (
                          <button onClick={() => void regenerate()} title={tr("chat.regenerateTitle")}><Icon name="repeat" size={13} />{tr("chat.regenerateBtn")}</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {isLoading && !streamStarted && (
              <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>
            )}
            {awaitingReply && (
              <button className="chat-retry" onClick={retry}>{tr("chat.retryBtn")}</button>
            )}
          </div>

          {(attached.length > 0 || pickerOpen) && (
            <div className="chat-attach">
              {attached.map((a) => (
                <span key={a.id} className="tx-chip static">{a.label}
                  <button className="chip-x" onClick={() => setAttached((p) => p.filter((x) => x.id !== a.id))} aria-label={tr("chat.removeAttachAria")}>×</button>
                </span>
              ))}
              {pickerOpen && (
                <div className="chat-picker">
                  <input autoFocus placeholder={tr("chat.attachSearchPlaceholder")} value={pquery} onChange={(e) => setPquery(e.target.value)} />
                  <div className="chat-picker-list">
                    {picks.slice(0, 8).map((t) => (
                      <button key={t.id} className="chat-picker-row"
                        onClick={() => addAttach({ id: t.id, label: `${(t.merchant || t.comment || tr("chat.txFallback")).slice(0, 22)} ${Math.round(t.amount / 100)}${sign(t.currency_code)}` })}>
                        <span className="cp-name">{t.merchant || t.comment || tr("chat.txFallback")}</span>
                        <span className="cp-amt">{Math.round(t.amount / 100)} {sign(t.currency_code)}</span>
                      </button>
                    ))}
                    {!picks.length && <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>{tr("chat.noResults")}</div>}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="chat-input">
            <button className="chat-attach-btn" onClick={() => setPickerOpen((o) => !o)} aria-label={tr("chat.attachTxAria")} title={tr("chat.attachTxAria")}>＋</button>
            <textarea
              ref={taRef}
              rows={1}
              autoFocus
              placeholder={tr("chat.inputPlaceholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="btn primary chat-send" onClick={() => send()} disabled={isLoading || !input.trim()} aria-label={tr("tx.chatSend")}>➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}
