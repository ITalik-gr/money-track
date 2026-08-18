import { useEffect, useMemo, useRef, useState } from "react";
import { getLocale, dateFmt, numFmt } from "../i18n/locale.ts";
import { AiChangeLog } from "../components/transactions/AiChangeLog.tsx";
import { translate, useT } from "../i18n/index.ts";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useChatTxMutation,
  useEditTransactionMutation,
  useEnrichTransactionMutation,
  useGetCategoriesQuery,
  useGetEventsQuery,
  useGetTransactionQuery,
  useGetTxChatQuery,
} from "../store/api.ts";
import { renderMarkdown } from "../lib/markdown.tsx";
import { Money } from "../components/ui/Money.tsx";
import { SimilarTx } from "../components/transactions/SimilarTx.tsx";
import { WhyCategory } from "../components/transactions/WhyCategory.tsx";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { currencySign } from "../lib/format.ts";
import { isNeutralTransfer, transferRoute } from "../lib/transfer.ts";
import { Select } from "../components/ui/Select.tsx";
import { TxSplitEditor } from "../components/transactions/TxSplitEditor.tsx";
import { TxReimbursement, TxReimbursementUsage } from "../components/transactions/TxReimbursement.tsx";
import { IMPORTANCE_LEVELS, IMPORTANCE_META } from "../lib/importance.ts";
import type { SelectOption } from "../components/ui/Select.tsx";
import type { Category } from "../../shared/types.ts";
import type { TxDetail } from "../store/api.ts";

// Категорії → опції Select: верхньорівневі, під кожною — відступлені підкатегорії.
function categoryOptions(cats: Category[] | undefined): SelectOption[] {
  const list = cats ?? [];
  const tops = list.filter((c) => c.parent_id == null);
  const out: SelectOption[] = [];
  for (const p of tops) {
    out.push({ value: p.id, label: p.name + (p.is_income ? " " + translate(getLocale(), "tx.categoryIncomeSuffix") : ""), color: p.color, icon: p.icon });
    for (const ch of list.filter((c) => c.parent_id === p.id)) {
      out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
    }
  }
  return out;
}

const MCC_HINT_KEY = "tx.mccHint";

// Текстовий дамп транзакції для буфера обміну — щоб скинути AI (в інший чат) або собі.
function buildTxDump(tx: TxDetail): string {
  const money = (minor: number, cur: number) =>
    `${numFmt({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)} ${currencySign(cur)}`;
  const when = dateFmt({ dateStyle: "long", timeStyle: "short" }).format(tx.time * 1000);
  const lk = (k: string, p?: Record<string, string | number>) => translate(getLocale(), k as never, p);
  const lines = [
    `${tx.merchant ?? tx.comment ?? lk("tx.dumpFallback")} — ${tx.amount > 0 ? "+" : ""}${money(tx.amount, tx.currency_code)}`,
    lk("tx.dumpDate", { when }),
    tx.account_title ? lk("tx.dumpAccount", { title: tx.account_title }) : null,
    tx.category_name ? lk("tx.dumpCategory", { name: tx.category_name }) : null,
    tx.real_category_name ? lk("tx.dumpRealCategory", { name: tx.real_category_name }) : null,
    tx.event_name ? lk("tx.dumpEvent", { name: tx.event_name }) : null,
    tx.tags.length ? lk("tx.dumpTags", { names: tx.tags.map((t) => t.name).join(", ") }) : null,
    tx.mcc ? lk("tx.dumpMcc", { mcc: String(tx.mcc) }) : null,
    tx.planned_title ? lk("tx.dumpPlanned", { title: tx.planned_title }) : null,
    tx.comment ? lk("tx.dumpBankComment", { text: tx.comment }) : null,
    tx.ai_note ? lk("tx.dumpAiNote", { note: tx.ai_note }) : null,
    tx.user_note ? lk("tx.dumpUserNote", { note: tx.user_note }) : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export function TxDetail() {
  const t = useT();
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

  if (isLoading) return <div className="empty">{t("common.loading")}</div>;
  if (!tx) return <div className="card empty">{t("tx.notFound")}</div>;

  const isMono = tx.source === "mono";
  const when = dateFmt({ dateStyle: "long", timeStyle: "short" }).format(tx.time * 1000);
  // Операція у бакеті «Перекази і зняття» — показуємо поле «реальна категорія» (§F2 крок 2).
  const looksTransfer = /переказ|зняття/i.test(tx.category_name ?? "") || isTransfer;
  // Подача — від збереженого факту (не від пенд-тогла у формі): див. `lib/transfer.ts`.
  const neutralTx = isNeutralTransfer(tx);
  // Mirrors the canon's `EFF_AMOUNT` for the non-split case: what is left as yours after the
  // compensation. Only outflows can carry one.
  const reimbursedMinor = tx.amount < 0 ? (tx.reimbursed ?? 0) : 0;
  const heroAmount = tx.amount + reimbursedMinor;
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
        toast.success(t("tx.savedEnriching"));
        try { await enrich(id).unwrap(); toast.success(t("tx.aiNoted")); }
        catch { toast.error(t("tx.aiNoteFailed")); }
      } else {
        toast.success(t("tx.saved"));
      }
    } catch (e) {
      toast.error(errText(e));
    }
  }

  // §R7: дозволити AI знову оновлювати назву (зняти ручний замок).
  async function unlockName() {
    try {
      await editTx({ id, body: { lock_name: false } }).unwrap();
      toast.success(t("tx.unlockNameDone"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <>
      <div className="section-head" style={{ justifyContent: "space-between" }}>
        <button className="btn ghost xs" style={{ marginLeft: -8 }} onClick={() => navigate(-1)}>← {t("tx.back")}</button>
        <button className="btn ghost xs"
          onClick={async () => {
            try { await navigator.clipboard.writeText(buildTxDump(tx)); toast.success(t("tx.copied")); }
            catch { toast.error(t("tx.copyFailed")); }
          }}>⧉ {t("tx.copy")}</button>
      </div>

      {/* Шапка: лого + сума героєм */}
      <div className="card" style={{ padding: 20, marginBottom: 14 }}>
        {/* `.txd-hero` замість інлайнового `.row`: на телефоні довга назва мерчанта
            («Хвиля здоров'я | Доставка води») ламалась у три рядки, бо поруч стояла сума з
            `white-space: nowrap` — колонка з назвою стискалась до ширини найдовшого слова.
            Клас дає змогу перевести шапку в стовпчик на вузькому екрані. */}
        <div className="txd-hero">
          <div className="txd-hero-who">
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
          <div className="txd-hero-amt">
            {/* §COMPENSATION: the hero shows the amount that is actually YOURS — the same figure
                the statistics use (`EFF_AMOUNT`). Showing the bank's charge here made a recorded
                compensation look like it had done nothing. The charge stays below, struck. */}
            {/* Переказ між своїми — гроші лишились власними: без знака й без червоного. */}
            <div className={`num-hero ${neutralTx ? "neutral" : heroAmount < 0 ? "neg" : "pos"}`} style={{ fontSize: 30 }}>
              {neutralTx && <Icon name="swap" size={19} className="hero-swap" />}
              {!neutralTx && heroAmount > 0 ? "+" : ""}
              {numFmt({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((neutralTx ? Math.abs(heroAmount) : heroAmount) / 100)}
              <span className="cur">{currencySign(tx.currency_code)}</span>
            </div>
            {reimbursedMinor > 0 && (
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                <s>{numFmt({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(tx.amount / 100)}</s>
                {" · "}{t("tx.reimbursedBy", { amount: numFmt({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(reimbursedMinor / 100) })}
              </div>
            )}
            {tx.original_amount != null && tx.original_currency != null && tx.original_currency !== tx.currency_code && (
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                {t("tx.paymentLabel")} {numFmt({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(tx.original_amount) / 100)}
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
            <FactLine k={t("tx.field.source")} v={isMono ? t("tx.source.mono") : tx.source === "cash" ? t("tx.source.cash") : t("tx.source.manual")} />
            <FactLine k={t("tx.field.account")} v={tx.account_title ?? "—"} />
            <FactLine k={t("tx.field.category")} v={tx.category_name ?? t("tx.noCategory")} dot={tx.category_color} />
            {looksTransfer && tx.real_category_name ? <FactLine k={t("tx.field.realCategory")} v={tx.real_category_name} dot={tx.real_category_color} /> : null}
            {tx.event_name ? <FactLine k={t("tx.field.event")} v={tx.event_name} dot={tx.event_color} /> : null}
            {tx.mcc ? <FactLine k={t(MCC_HINT_KEY)} v={String(tx.mcc)} mono /> : null}
            {tx.cashback ? <FactLine k={t("tx.field.cashback")} v={<Money minor={tx.cashback} currency={tx.currency_code} />} /> : null}
            {tx.balance_after != null ? <FactLine k={t("tx.field.balanceAfter")} v={<Money minor={tx.balance_after} currency={tx.currency_code} />} /> : null}
            {tx.comment ? <FactLine k={t("tx.field.bankComment")} v={tx.comment} /> : null}
          </div>

          {/* §SPLIT: поділ витрати на кілька категорій (не для переказів/надходжень) */}
          {tx.amount < 0 && !looksTransfer && (
            <TxSplitEditor txId={id} amount={tx.amount} currency={tx.currency_code} cats={cats} />
          )}

          {/* §COMPENSATION: «мені скинули за це» — у витратах лишається лише своя частина */}
          {tx.amount < 0 && !looksTransfer && (
            <TxReimbursement txId={id} amount={tx.amount} currency={tx.currency_code} />
          )}

          {/* Зворотний бік для надходження: куди воно пішло і скільки з нього ще вільно */}
          {tx.amount > 0 && (
            <TxReimbursementUsage txId={id} amount={tx.amount} currency={tx.currency_code} />
          )}

          {/* Окремий AI-блок: що AI знає + розпізнавання + нотатка + інлайн-чат */}
          <div className="card ai-block">
            <div className="ai-block-head">
              <span className="ai-block-title"><Icon name="spark" size={16} />{t("tx.aiBlockTitle")}</span>
              <button className="btn ai-recognize" disabled={enriching}
                onClick={async () => {
                  try { await enrich(id).unwrap(); toast.success(t("tx.aiEnrichedDone")); }
                  catch (e) { toast.error(errText(e)); }
                }}>{enriching ? t("tx.analyzing") : t("tx.recognize")}</button>
            </div>

            {/*
              The lead: WHAT this is and WHY, in one sentence, before any table. The block used to
              open with a `status · recognised as · category` grid — eight rows of what the app
              decided and not one word of what it decided from, which reads as a machine reporting
              to itself.
            */}
            <WhyCategory txId={id} />

            {/*
              The facts stay, folded. They are reference — the exact MCC, the tags, the plan link —
              wanted rarely and specifically, and open by default they were the loudest thing on a
              page whose subject is a single payment. Native `<details>`: it keeps keyboard and
              screen-reader behaviour that a custom toggle would have to reimplement badly.
            */}
            <details className="ai-details">
              <summary className="ai-details-sum">{t("tx.aiFactsSummary")}</summary>
            <div className="ai-facts">
              <div className="ai-fact">
                <span className="ai-fact-k">{t("tx.aiFact.status")}</span>
                <span className="ai-fact-v">{tx.ai_enriched ? t("tx.aiStatusEnriched") : t("tx.aiStatusNotEnriched")}</span>
              </div>
              <div className="ai-fact">
                <span className="ai-fact-k">{t("tx.aiFact.recognizedAs")}</span>
                <span className="ai-fact-v">{tx.merchant ?? tx.comment ?? "—"}</span>
              </div>
              {tx.user_note && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{t("tx.aiFact.myNote")}</span>
                  <span className="ai-fact-v">📝 {tx.user_note}</span>
                </div>
              )}
              {tx.ai_note && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{t("tx.aiFact.aiUnderstands")}</span>
                  <span className="ai-fact-v">{tx.ai_note}</span>
                </div>
              )}
              {tx.planned_title && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{t("tx.aiFact.planned")}</span>
                  <span className="ai-fact-v">🔁 {tx.planned_title}</span>
                </div>
              )}
              <div className="ai-fact">
                <span className="ai-fact-k">{t("tx.aiFact.category")}</span>
                <span className="ai-fact-v">
                  {tx.category_color && <span className="ai-fact-dot" style={{ background: tx.category_color }} />}
                  {tx.category_name ?? t("tx.noCategory")}
                </span>
              </div>
              {looksTransfer && tx.real_category_name && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{t("tx.aiFact.realCategory")}</span>
                  <span className="ai-fact-v">
                    {tx.real_category_color && <span className="ai-fact-dot" style={{ background: tx.real_category_color }} />}
                    {tx.real_category_name}
                  </span>
                </div>
              )}
              {tx.tags.length > 0 && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{t("tx.aiFact.tags")}</span>
                  <span className="ai-fact-v ai-fact-tags">
                    {tx.tags.map((t) => (
                      <span key={t.id} className="ai-tag"><span className="ai-fact-dot" style={{ background: t.color ?? "var(--muted)" }} />{t.name}</span>
                    ))}
                  </span>
                </div>
              )}
              {tx.mcc && (
                <div className="ai-fact">
                  <span className="ai-fact-k">{t(MCC_HINT_KEY)}</span>
                  <span className="ai-fact-v mono">{tx.mcc}</span>
                </div>
              )}
            </div>
            </details>

            <label className="stack" style={{ gap: 4, marginTop: 12 }}>
              <span className="label">{t("tx.label.noteForAi")}</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t("tx.placeholder.noteForAi")} />
              <span className="ai-block-sub">{t("tx.noteHint")}</span>
            </label>

            {/* Інлайн-чат: обговорити операцію, уточнити («це відпочинок») — AI оновить категорію */}
            {/* §AI-AUDIT sits directly ABOVE the chat: the chat is where most of these changes
                come from, so the record of them belongs next to their source. */}
            <AiChangeLog txId={id} />
            <TxAiChat txId={id} txName={tx.merchant ?? tx.comment ?? t("tx.chatFallback")} />
          </div>

          {tx.receipt && (
            <div>
              <div className="section-head"><h2>{t("tx.section.receipt")}</h2></div>
              <div className="card facts">
                <FactLine k={t("tx.receipt.store")} v={tx.receipt.store ?? "—"} />
                {tx.receipt.total != null && <FactLine k={t("tx.receipt.total")} v={<Money minor={tx.receipt.total} currency={tx.receipt.currency_code ?? 980} />} />}
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
          <div className="section-head"><h2>{t("tx.section.edit")}</h2></div>
          <div className="card" style={{ padding: 16 }}>
            <div className="stack">
              <label className="stack" style={{ gap: 4 }}>
                <span className="label">{t("tx.label.merchant")}</span>
                <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder={t("tx.placeholder.merchant")} />
                {tx.name_locked ? (
                  <span className="ai-block-sub" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {"🔒 "}{t("tx.nameLocked")}{" "}
                    <button type="button" className="link-btn" onClick={unlockName}>{t("tx.unlockNameLink")}</button>
                  </span>
                ) : (
                  <span className="ai-block-sub">{t("tx.nameEditHint")}</span>
                )}
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="label">{t("tx.label.category")}</span>
                <Select value={categoryId} options={catOptions} searchable clearable clearLabel={t("tx.clearLabel.noCategory")}
                  placeholder={t("tx.clearLabel.noCategory")} onChange={(v) => setCategoryId(v == null ? null : Number(v))} />
              </label>

              {looksTransfer && (
                <label className="stack" style={{ gap: 4 }}>
                  <span className="label">{t("tx.label.realCategory")}</span>
                  <Select value={realCategoryId} options={catOptions} searchable clearable clearLabel={t("tx.clearLabel.notDefined")}
                    placeholder={t("tx.placeholder.realCategory")} onChange={(v) => setRealCategoryId(v == null ? null : Number(v))} />
                  <span className="ai-block-sub">{t("tx.realCategoryHint")}</span>
                </label>
              )}

              <label className="stack" style={{ gap: 4 }}>
                <span className="label">{t("tx.label.event")}</span>
                <Select value={eventId} clearable clearLabel={t("tx.clearLabel.noEvent")} placeholder={t("tx.clearLabel.noEvent")}
                  onChange={(v) => setEventId(v == null ? null : Number(v))}
                  options={events.map((ev) => ({ value: ev.id, label: ev.name, color: ev.color }))} />
              </label>

              {!looksTransfer && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="label">{t("tx.label.importance")}</span>
                  <div className="imp-picker">
                    <button type="button" className={`imp-opt ${importance == null ? "on" : ""}`} onClick={() => setImportance(null)}>{t("tx.importanceAsCategory")}</button>
                    {IMPORTANCE_LEVELS.map((lv) => {
                      const m = IMPORTANCE_META[lv];
                      const on = importance === lv;
                      return (
                        <button key={lv} type="button" title={t(m.hintKey)}
                          className={`imp-opt ${on ? "on" : ""}`}
                          style={on ? { borderColor: m.color, background: `color-mix(in srgb, ${m.color} 14%, transparent)`, color: m.color } : undefined}
                          onClick={() => setImportance(lv)}>
                          <span className="d" style={{ background: m.color }} />{t(m.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="label">{t("tx.label.tags")}</span>
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

                {/*
                  Folded (2026-08-14). Forty category chips in a scrolling box were the tallest
                  thing on the page — for a field that takes at most THREE tags and is usually
                  left empty. The chosen ones stay above, outside the fold, so nothing already set
                  is hidden. `<details>` keeps keyboard and screen-reader behaviour for free.
                */}
                <details className="tag-pick">
                  <summary className="disclose">{t("tx.tagsPick")}</summary>

                <input className="tag-search" value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder={t("tx.placeholder.tagSearch")} />

                {(() => {
                  const qq = tagQuery.trim().toLowerCase();
                  const matches = (c: Category) => c.id !== categoryId && !tags.includes(c.id) && (!qq || c.name.toLowerCase().includes(qq));
                  const groups: [string, Category[]][] = [
                    [t("tx.tagGroup.expenses"), orderedCats.filter((c) => !c.is_income && matches(c))],
                    [t("tx.tagGroup.income"), orderedCats.filter((c) => c.is_income && matches(c))],
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
                      {atMax && <div className="ai-block-sub">{t("tx.tagsMax3")}</div>}
                    </div>
                  );
                })()}
                </details>
              </div>

              {isMono && (
                <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
                  <span style={{ fontSize: 13 }}>
                    {t("tx.learnHint.before")} <strong>{t("tx.learnHint.strong")}</strong> {t("tx.learnHint.after")}
                  </span>
                </label>
              )}
              <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={isTransfer} onChange={(e) => setIsTransfer(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
                <span style={{ fontSize: 13 }}>
                  {t("tx.transferHint.before")} <strong>{t("tx.transferHint.strong")}</strong> {t("tx.transferHint.after")}
                </span>
              </label>
              <button className="btn primary" onClick={save} disabled={saving}>{saving ? t("tx.saving") : t("common.save")}</button>
            </div>
          </div>

          {/*
            Under the editor, not above it: the question "should the others be like this too?" only
            makes sense once this one is right. Reads the SAVED state (`tx`), never the unsaved form
            — offering to copy a category that has not been stored yet would apply something the
            person is still deciding about.
          */}
          <SimilarTx txId={id} categoryId={tx.category_id ?? null} isTransfer={!!tx.is_transfer} />
        </div>
      </div>
    </>
  );
}

type ChatMsg = { role: "user" | "assistant"; content: string };

/**
 * The conversation about ONE operation: the person clarifies ("this was for the course"), the
 * model answers and may update the category or the transfer flag (applied server-side).
 *
 * §TX-CHAT (2026-08-12): the exchange is STORED. It used to live in this component's `useState`,
 * so it existed until the user navigated away and then was gone — strictly worse than the state
 * §CHAT-SYNC was created to end. Somebody would explain why a payment is not what it looks like,
 * the model would use it, and an hour later there was no evidence the explanation had ever
 * happened. Now it loads with the page, so the operation carries its own history: what was said
 * about it, and when.
 */
function TxAiChat({ txId, txName }: { txId: string; txName: string }) {
  const t = useT();
  const [chatTx, { isLoading: chatting }] = useChatTxMutation();
  const { data: history } = useGetTxChatQuery(txId);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const sending = useRef(false);

  // Server history seeds the thread once. Not `messages = history` on every render: the optimistic
  // user turn is added locally the moment it is sent, and re-reading the server between the send
  // and its answer would make the question flicker out and back.
  useEffect(() => {
    if (history && messages.length === 0) setMessages(history as ChatMsg[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

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
      if (r.applied?.category_name) toast.success(t("tx.aiUpdatedCategory", { name: r.applied.category_name }));
      if (r.applied?.is_transfer) toast.success(t("tx.aiMarkedTransfer"));
      if (r.applied?.understanding) toast.success(t("tx.aiUpdatedUnderstanding"));
    } catch (e) {
      // Показуємо РЕАЛЬНУ причину (ліміт, ключ, збій моделі), а не глухе «спробуй ще раз» —
      // інакше діагностувати AI-помилку неможливо (див. `lib/errors.ts`).
      setMessages((m) => [...m, { role: "assistant", content: t("tx.chatReplyFailed", { error: errText(e) }) }]);
    } finally { sending.current = false; }
  }

  return (
    <div className="tx-chat">
      {/* An `Icon`, not an emoji: every other section head in the app uses one, and the emoji
          rendered glued to the text because the head is a flex row that collapses the space. */}
      <div className="tx-chat-head"><Icon name="advisor" size={15} />{t("tx.chatHead")}</div>
      {messages.length === 0 && !chatting && (
        <div className="tx-chat-hint">
          {t("tx.chatHint")}
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
        <input placeholder={t("tx.chatInputPlaceholder", { name: txName })} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        <button className="btn primary" onClick={() => send()} disabled={chatting || !input.trim()} aria-label={t("tx.chatSend")}>➤</button>
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
