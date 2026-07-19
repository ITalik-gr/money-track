import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useChatTxMutation,
  useEditTransactionMutation,
  useEnrichTransactionMutation,
  useGetCategoriesQuery,
  useGetEventsQuery,
  useGetTransactionQuery,
} from "../store/api.ts";
import { renderMarkdown } from "../lib/markdown.tsx";
import { Money } from "../components/Money.tsx";
import { MerchantLogo } from "../components/MerchantLogo.tsx";
import { Icon } from "../components/Icon.tsx";
import { toast } from "../lib/toast.ts";
import { currencySign } from "../lib/format.ts";
import { isNeutralTransfer, transferRoute } from "../lib/transfer.ts";
import { Select } from "../components/Select.tsx";
import { TxSplitEditor } from "../components/TxSplitEditor.tsx";
import { IMPORTANCE_LEVELS, IMPORTANCE_META } from "../lib/importance.ts";
import type { SelectOption } from "../components/Select.tsx";
import type { Category } from "../../shared/types.ts";
import type { TxDetail } from "../store/api.ts";

// Категорії → опції Select: верхньорівневі, під кожною — відступлені підкатегорії.
function categoryOptions(cats: Category[] | undefined): SelectOption[] {
  const list = cats ?? [];
  const tops = list.filter((c) => c.parent_id == null);
  const out: SelectOption[] = [];
  for (const p of tops) {
    out.push({ value: p.id, label: p.name + (p.is_income ? " (дохід)" : ""), color: p.color, icon: p.icon });
    for (const ch of list.filter((c) => c.parent_id === p.id)) {
      out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
    }
  }
  return out;
}

const MCC_HINT = "код типу торговця (MCC)";

// Текстовий дамп транзакції для буфера обміну — щоб скинути AI (в інший чат) або собі.
function buildTxDump(tx: TxDetail): string {
  const money = (minor: number, cur: number) =>
    `${new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)} ${currencySign(cur)}`;
  const when = new Intl.DateTimeFormat("uk-UA", { dateStyle: "long", timeStyle: "short" }).format(tx.time * 1000);
  const lines = [
    `${tx.merchant ?? tx.comment ?? "Операція"} — ${tx.amount > 0 ? "+" : ""}${money(tx.amount, tx.currency_code)}`,
    `Дата: ${when}`,
    tx.account_title ? `Рахунок: ${tx.account_title}` : null,
    tx.category_name ? `Категорія: ${tx.category_name}` : null,
    tx.real_category_name ? `Реальна категорія: ${tx.real_category_name}` : null,
    tx.event_name ? `Група: ${tx.event_name}` : null,
    tx.tags.length ? `Теги: ${tx.tags.map((t) => t.name).join(", ")}` : null,
    tx.mcc ? `MCC: ${tx.mcc}` : null,
    tx.planned_title ? `Підписка: ${tx.planned_title}` : null,
    tx.comment ? `Коментар банку: ${tx.comment}` : null,
    tx.ai_note ? `AI розуміє як: ${tx.ai_note}` : null,
    tx.user_note ? `Нотатка: ${tx.user_note}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export function TxDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data: tx, isLoading } = useGetTransactionQuery(id, { skip: !id });
  const { data: cats } = useGetCategoriesQuery();
  const { data: events = [] } = useGetEventsQuery();
  const [editTx, { isLoading: saving }] = useEditTransactionMutation();
  const [enrich, { isLoading: enriching }] = useEnrichTransactionMutation();

  const [merchant, setMerchant] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [realCategoryId, setRealCategoryId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<number[]>([]);
  const [eventId, setEventId] = useState<number | null>(null);
  const [learn, setLearn] = useState(false);
  const [isTransfer, setIsTransfer] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const [importance, setImportance] = useState<string | null>(null); // §6: override; null = як категорія

  const catOptions = useMemo(() => categoryOptions(cats), [cats]);
  // Плаский, але впорядкований список: батько → його підкатегорії (для тегів-списку).
  const orderedCats = useMemo(() => {
    const list = cats ?? [];
    const out: Category[] = [];
    for (const p of list.filter((c) => c.parent_id == null)) {
      out.push(p);
      for (const ch of list.filter((c) => c.parent_id === p.id)) out.push(ch);
    }
    return out;
  }, [cats]);

  // Заповнюємо форму, коли транзакція підвантажилась.
  useEffect(() => {
    if (tx) {
      setMerchant(tx.merchant ?? "");
      setCategoryId(tx.category_id);
      setRealCategoryId(tx.real_category_id ?? null);
      setNote(tx.user_note ?? "");
      setIsTransfer(!!tx.is_transfer);
      setEventId(tx.event_id ?? null);
      setTags((tx.tags ?? []).map((t) => t.id));
      setImportance(tx.importance ?? null);
    }
  }, [tx]);

  function toggleTag(id: number) {
    setTags((prev) => prev.includes(id) ? prev.filter((t) => t !== id) : prev.length >= 3 ? prev : [...prev, id]);
  }

  if (isLoading) return <div className="empty">Завантаження…</div>;
  if (!tx) return <div className="card empty">Транзакцію не знайдено.</div>;

  const isMono = tx.source === "mono";
  const when = new Intl.DateTimeFormat("uk-UA", { dateStyle: "long", timeStyle: "short" }).format(tx.time * 1000);
  // Операція у бакеті «Перекази і зняття» — показуємо поле «реальна категорія» (§F2 крок 2).
  const looksTransfer = /переказ|зняття/i.test(tx.category_name ?? "") || isTransfer;
  // Подача — від збереженого факту (не від пенд-тогла у формі): див. `lib/transfer.ts`.
  const neutralTx = isNeutralTransfer(tx);
  const route = transferRoute(tx);

  async function save() {
    try {
      const noteChanged = note.trim() !== (tx?.user_note ?? "").trim();
      await editTx({
        id,
        body: {
          merchant: merchant.trim() || null,
          category_id: categoryId,
          user_note: note.trim() || null,
          learn: isMono && learn,
          is_transfer: isTransfer,
          event_id: eventId,
          tags,
          importance,
          ...(looksTransfer ? { real_category_id: realCategoryId } : {}),
        },
      }).unwrap();
      setLearn(false);
      // §R6: якщо я написав/змінив нотатку для AI — одразу переосмислюємо категорію з нею
      // (enrich має пріоритет №1 на user_note). Так «це було за освіту» реально спрацьовує.
      if (noteChanged && note.trim()) {
        toast.success("Збережено · переосмислюю з AI…");
        try { await enrich(id).unwrap(); toast.success("AI врахував нотатку"); }
        catch { toast.error("Нотатку збережено, але AI не відповів"); }
      } else {
        toast.success("Збережено");
      }
    } catch (e) {
      toast.error(String(e));
    }
  }

  // §R7: дозволити AI знову оновлювати назву (зняти ручний замок).
  async function unlockName() {
    try {
      await editTx({ id, body: { lock_name: false } }).unwrap();
      toast.success("AI зможе оновлювати назву");
    } catch (e) { toast.error(String(e)); }
  }

  return (
    <>
      <div className="section-head" style={{ justifyContent: "space-between" }}>
        <button className="btn ghost" style={{ padding: "4px 8px", marginLeft: -8 }} onClick={() => navigate(-1)}>← назад</button>
        <button className="btn ghost" style={{ padding: "4px 10px" }}
          onClick={async () => {
            try { await navigator.clipboard.writeText(buildTxDump(tx)); toast.success("Скопійовано"); }
            catch { toast.error("Не вдалося скопіювати"); }
          }}>⧉ Копіювати</button>
      </div>

      {/* Шапка: лого + сума героєм */}
      <div className="card" style={{ padding: 20, marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 14 }}>
          <div className="row" style={{ gap: 13, minWidth: 0 }}>
            <MerchantLogo merchant={tx.merchant} catIcon={tx.category_icon} color={tx.category_color} transfer={!!tx.is_transfer} fallbackLabel={tx.category_name} />
            <div style={{ minWidth: 0 }}>
              <div className="who" style={{ fontSize: 18, fontWeight: 600 }}>
                {tx.merchant
                  ? <Link to={`/merchant/${encodeURIComponent(tx.merchant)}`} className="merchant-link">{tx.merchant}</Link>
                  : (tx.comment ?? "—")}
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{when}</div>
            </div>
          </div>
          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            {/* Переказ між своїми — гроші лишились власними: без знака й без червоного. */}
            <div className={`num-hero ${neutralTx ? "neutral" : tx.amount < 0 ? "neg" : "pos"}`} style={{ fontSize: 30 }}>
              {neutralTx && <Icon name="swap" size={19} className="hero-swap" />}
              {!neutralTx && tx.amount > 0 ? "+" : ""}
              {new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((neutralTx ? Math.abs(tx.amount) : tx.amount) / 100)}
              <span className="cur">{tx.currency_code === 840 ? "$" : tx.currency_code === 978 ? "€" : "₴"}</span>
            </div>
            {tx.original_amount != null && tx.original_currency != null && tx.original_currency !== tx.currency_code && (
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                оплата: {new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(tx.original_amount) / 100)}
                {" "}{currencySign(tx.original_currency)}
              </div>
            )}
          </div>
        </div>

        {/* Маршрут «звідки → куди» — головне, що треба знати про переказ між своїми. */}
        {route && (
          <div className="tx-route">
            <span className="tx-route-acc">{route.from}</span>
            <Icon name="arrowRight" size={15} className="tx-route-arrow" />
            <span className="tx-route-acc">{route.to}</span>
          </div>
        )}
      </div>

      {/* 2 колонки: факти + AI (+чек) ліворуч, редагування праворуч */}
      <div className="txd-grid">
        <div className="stack" style={{ gap: 14 }}>
          <div className="card facts">
            <FactLine k="Джерело" v={isMono ? "Monobank" : tx.source === "cash" ? "Готівка" : "Вручну"} />
            <FactLine k="Рахунок" v={tx.account_title ?? "—"} />
            <FactLine k="Категорія" v={tx.category_name ?? "без категорії"} dot={tx.category_color} />
            {looksTransfer && tx.real_category_name ? <FactLine k="Реальна категорія" v={tx.real_category_name} dot={tx.real_category_color} /> : null}
            {tx.event_name ? <FactLine k="Група" v={tx.event_name} dot={tx.event_color} /> : null}
            {tx.mcc ? <FactLine k={MCC_HINT} v={String(tx.mcc)} mono /> : null}
            {tx.cashback ? <FactLine k="Кешбек" v={<Money minor={tx.cashback} currency={tx.currency_code} />} /> : null}
            {tx.balance_after != null ? <FactLine k="Баланс після" v={<Money minor={tx.balance_after} currency={tx.currency_code} />} /> : null}
            {tx.comment ? <FactLine k="Коментар банку" v={tx.comment} /> : null}
          </div>

          {/* §SPLIT: поділ витрати на кілька категорій (не для переказів/надходжень) */}
          {tx.amount < 0 && !looksTransfer && (
            <TxSplitEditor txId={id} amount={tx.amount} currency={tx.currency_code} cats={cats} />
          )}

          {/* Окремий AI-блок: що AI знає + розпізнавання + нотатка + інлайн-чат */}
          <div className="card ai-block">
            <div className="ai-block-head">
              <span className="ai-block-title">✨ AI про цю операцію</span>
              <button className="btn ai-recognize" disabled={enriching}
                onClick={async () => {
                  try { await enrich(id).unwrap(); toast.success("AI оновив назву й категорію"); }
                  catch (e) { toast.error(String(e)); }
                }}>{enriching ? "Аналізую…" : "Розпізнати"}</button>
            </div>

            {/* Панель фактів: що AI розпізнав про цю операцію */}
            <div className="ai-facts">
              <div className="ai-fact">
                <span className="ai-fact-k">Статус</span>
                <span className="ai-fact-v">{tx.ai_enriched ? "AI опрацював цю операцію" : "AI ще не опрацьовував"}</span>
              </div>
              <div className="ai-fact">
                <span className="ai-fact-k">Розпізнав як</span>
                <span className="ai-fact-v">{tx.merchant ?? tx.comment ?? "—"}</span>
              </div>
              {tx.user_note && (
                <div className="ai-fact">
                  <span className="ai-fact-k">Моя нотатка</span>
                  <span className="ai-fact-v">📝 {tx.user_note}</span>
                </div>
              )}
              {tx.ai_note && (
                <div className="ai-fact">
                  <span className="ai-fact-k">AI розуміє це як</span>
                  <span className="ai-fact-v">{tx.ai_note}</span>
                </div>
              )}
              {tx.planned_title && (
                <div className="ai-fact">
                  <span className="ai-fact-k">Підписка</span>
                  <span className="ai-fact-v">🔁 {tx.planned_title}</span>
                </div>
              )}
              <div className="ai-fact">
                <span className="ai-fact-k">Категорія</span>
                <span className="ai-fact-v">
                  {tx.category_color && <span className="ai-fact-dot" style={{ background: tx.category_color }} />}
                  {tx.category_name ?? "без категорії"}
                </span>
              </div>
              {looksTransfer && tx.real_category_name && (
                <div className="ai-fact">
                  <span className="ai-fact-k">Реальна категорія</span>
                  <span className="ai-fact-v">
                    {tx.real_category_color && <span className="ai-fact-dot" style={{ background: tx.real_category_color }} />}
                    {tx.real_category_name}
                  </span>
                </div>
              )}
              {tx.tags.length > 0 && (
                <div className="ai-fact">
                  <span className="ai-fact-k">Теги</span>
                  <span className="ai-fact-v ai-fact-tags">
                    {tx.tags.map((t) => (
                      <span key={t.id} className="ai-tag"><span className="ai-fact-dot" style={{ background: t.color ?? "var(--muted)" }} />{t.name}</span>
                    ))}
                  </span>
                </div>
              )}
              {tx.mcc && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{MCC_HINT}</span>
                  <span className="ai-fact-v mono">{tx.mcc}</span>
                </div>
              )}
            </div>

            <label className="stack" style={{ gap: 4, marginTop: 12 }}>
              <span className="label">нотатка для AI</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="напр. «це було за освіту», «це подарунок, не рахуй як регулярне»" />
              <span className="ai-block-sub">Після «Зберегти» AI одразу переосмислить категорію з урахуванням нотатки. Також враховується в інсайтах і порадах.</span>
            </label>

            {/* Інлайн-чат: обговорити операцію, уточнити («це відпочинок») — AI оновить категорію */}
            <TxAiChat txId={id} txName={tx.merchant ?? tx.comment ?? "операцію"} />
          </div>

          {tx.receipt && (
            <div>
              <div className="section-head"><h2>Чек</h2></div>
              <div className="card facts">
                <FactLine k="Магазин" v={tx.receipt.store ?? "—"} />
                {tx.receipt.total != null && <FactLine k="Разом" v={<Money minor={tx.receipt.total} currency={tx.receipt.currency_code ?? 980} />} />}
                {(tx.receipt.items ?? []).map((it) => (
                  <div key={it.id} className="fact-line">
                    <span className="fact-k" style={{ textTransform: "none" }}>{it.name}{it.qty && it.qty !== 1 ? ` ×${it.qty}` : ""}</span>
                    <span className="fact-v"><Money minor={it.price ?? 0} currency={tx.receipt!.currency_code ?? 980} /></span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Редагування */}
        <div>
          <div className="section-head"><h2>Редагувати</h2></div>
          <div className="card" style={{ padding: 16 }}>
            <div className="stack">
              <label className="stack" style={{ gap: 4 }}>
                <span className="label">мерчант / назва</span>
                <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="напр. кавʼярня біля дому" />
                {tx.name_locked ? (
                  <span className="ai-block-sub" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    🔒 Ти задав цю назву — AI її не змінюватиме.
                    <button type="button" className="link-btn" onClick={unlockName}>дозволити AI оновлювати</button>
                  </span>
                ) : (
                  <span className="ai-block-sub">Зміниш назву — AI більше не перезаписуватиме її автоматично.</span>
                )}
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="label">категорія</span>
                <Select value={categoryId} options={catOptions} searchable clearable clearLabel="— без категорії"
                  placeholder="— без категорії" onChange={(v) => setCategoryId(v == null ? null : Number(v))} />
              </label>

              {looksTransfer && (
                <label className="stack" style={{ gap: 4 }}>
                  <span className="label">реальна категорія переказу/зняття</span>
                  <Select value={realCategoryId} options={catOptions} searchable clearable clearLabel="— не визначено"
                    placeholder="— на що пішли кошти?" onChange={(v) => setRealCategoryId(v == null ? null : Number(v))} />
                  <span className="ai-block-sub">Операція лишається у «Переказах і зняттях», але тут — на що кошти пішли насправді (зняв готівку → «Продукти»). «Розпізнати» вгорі підкаже через AI.</span>
                </label>
              )}

              <label className="stack" style={{ gap: 4 }}>
                <span className="label">група / проєкт</span>
                <Select value={eventId} clearable clearLabel="— без групи" placeholder="— без групи"
                  onChange={(v) => setEventId(v == null ? null : Number(v))}
                  options={events.map((ev) => ({ value: ev.id, label: ev.name, color: ev.color }))} />
              </label>

              {!looksTransfer && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="label">вагомість (перевизначити категорію)</span>
                  <div className="imp-picker">
                    <button type="button" className={`imp-opt ${importance == null ? "on" : ""}`} onClick={() => setImportance(null)}>як категорія</button>
                    {IMPORTANCE_LEVELS.map((lv) => {
                      const m = IMPORTANCE_META[lv];
                      const on = importance === lv;
                      return (
                        <button key={lv} type="button" title={m.hint}
                          className={`imp-opt ${on ? "on" : ""}`}
                          style={on ? { borderColor: m.color, background: `color-mix(in srgb, ${m.color} 14%, transparent)`, color: m.color } : undefined}
                          onClick={() => setImportance(lv)}>
                          <span className="d" style={{ background: m.color }} />{m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="label">теги для контексту</span>
                  <span className="tags-count">{tags.length}/3</span>
                </div>

                {/* Вибрані — чипами зверху, щоб було видно й легко зняти */}
                {tags.length > 0 && (
                  <div className="tag-chosen">
                    {tags.map((id) => {
                      const c = orderedCats.find((x) => x.id === id);
                      if (!c) return null;
                      return (
                        <button key={id} type="button" className="tag-chip on" onClick={() => toggleTag(id)}>
                          <span className="d" style={{ background: c.color ?? "var(--muted)" }} />
                          {c.name}
                          <span className="tag-chip-x">×</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <input className="tag-search" value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="пошук тегу…" />

                {(() => {
                  const qq = tagQuery.trim().toLowerCase();
                  const matches = (c: Category) => c.id !== categoryId && !tags.includes(c.id) && (!qq || c.name.toLowerCase().includes(qq));
                  const groups: [string, Category[]][] = [
                    ["Витрати", orderedCats.filter((c) => !c.is_income && matches(c))],
                    ["Доходи", orderedCats.filter((c) => c.is_income && matches(c))],
                  ];
                  const atMax = tags.length >= 3;
                  return (
                    <div className="tag-groups">
                      {groups.map(([title, listc]) => listc.length === 0 ? null : (
                        <div key={title} className="tag-group">
                          <div className="tag-group-h">{title}</div>
                          <div className="tag-chips">
                            {listc.map((c) => (
                              <button key={c.id} type="button" disabled={atMax}
                                className={`tag-chip ${c.parent_id ? "sub" : ""}`} onClick={() => toggleTag(c.id)}>
                                <span className="d" style={{ background: c.color ?? "var(--muted)" }} />
                                {c.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                      {atMax && <div className="ai-block-sub">Максимум 3 теги — зніми якийсь, щоб додати інший.</div>}
                    </div>
                  );
                })()}
              </div>

              {isMono && (
                <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
                  <span style={{ fontSize: 13 }}>
                    Застосувати до всіх таких і <strong>запамʼятати</strong> — наступні транзакції з тим самим описом отримають цю назву й категорію автоматично.
                  </span>
                </label>
              )}
              <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={isTransfer} onChange={(e) => setIsTransfer(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
                <span style={{ fontSize: 13 }}>
                  Це <strong>переказ</strong> між своїми рахунками — не рахувати як витрату/дохід у статистиці.
                </span>
              </label>
              <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Зберігаю…" : "Зберегти"}</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

type ChatMsg = { role: "user" | "assistant"; content: string };

// Інлайн-чат по конкретній операції: користувач уточнює («це відпочинок»), AI відповідає
// й може оновити категорію/прапорець переказу (застосовується на бекенді, тег Tx інвалідиться).
function TxAiChat({ txId, txName }: { txId: string; txName: string }) {
  const [chatTx, { isLoading: chatting }] = useChatTxMutation();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const sending = useRef(false);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || chatting || sending.current) return;
    sending.current = true;
    const next: ChatMsg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    try {
      const r = await chatTx({ id: txId, messages: next }).unwrap();
      setMessages((m) => [...m, { role: "assistant", content: r.reply }]);
      if (r.applied?.category_name) toast.success(`AI оновив категорію → ${r.applied.category_name}`);
      if (r.applied?.is_transfer) toast.success("AI позначив як переказ між своїми");
      if (r.applied?.understanding) toast.success("AI оновив розуміння операції");
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Не вдалося відповісти. Спробуй ще раз." }]);
    } finally { sending.current = false; }
  }

  return (
    <div className="tx-chat">
      <div className="tx-chat-head">💬 Обговорити з AI</div>
      {messages.length === 0 && !chatting && (
        <div className="tx-chat-hint">
          Уточни, що це насправді — напр. «це відпочинок», «поверни в кафе», «це переказ мамі». AI відповість і, за потреби, оновить категорію.
        </div>
      )}
      {messages.length > 0 && (
        <div className="tx-chat-log">
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.role === "assistant" ? renderMarkdown(m.content) : m.content}
            </div>
          ))}
          {chatting && <div className="chat-msg assistant chat-typing"><span></span><span></span><span></span></div>}
        </div>
      )}
      <div className="tx-chat-input">
        <input placeholder={`Спитати про «${txName}»…`} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        <button className="btn primary" onClick={() => send()} disabled={chatting || !input.trim()} aria-label="Надіслати">➤</button>
      </div>
    </div>
  );
}

function FactLine({ k, v, dot, mono }: { k: string; v: React.ReactNode; dot?: string | null; mono?: boolean }) {
  return (
    <div className="fact-line">
      <span className="fact-k">{k}</span>
      <span className={`fact-v ${mono ? "mono" : ""}`}>
        {dot && <span className="fact-dot" style={{ background: dot }} />}
        {v}
      </span>
    </div>
  );
}
