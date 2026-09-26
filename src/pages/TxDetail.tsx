import { catColor } from "../lib/theme.ts";
import { useEffect, useMemo, useState } from "react";
import { getLocale, dateFmt, numFmt } from "../i18n/locale.ts";
import { translate, useT } from "../i18n/index.ts";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useEditTransactionMutation,
  useGetCategoriesQuery,
  useGetEventsQuery,
  useGetTransactionQuery,
} from "../store/api.ts";
import { Money } from "../components/ui/Money.tsx";
import { SimilarTx } from "../components/transactions/SimilarTx.tsx";
import { TxAiBlock } from "../components/transactions/TxAiBlock.tsx";
import { BusinessToggle } from "../components/fop/BusinessToggle.tsx";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
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
  const { data: tx, isLoading, error, refetch } = useGetTransactionQuery(id, { skip: !id });
  const { data: cats } = useGetCategoriesQuery();
  const { data: events = [] } = useGetEventsQuery();
  const [editTx, { isLoading: saving }] = useEditTransactionMutation();

  const [merchant, setMerchant] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [realCategoryId, setRealCategoryId] = useState<number | null>(null);
  const [tags, setTags] = useState<number[]>([]);
  const [eventId, setEventId] = useState<number | null>(null);
  const [learn, setLearn] = useState(false);
  const [isTransfer, setIsTransfer] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
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
  // A failed request is not «not found»: the row may well exist, and saying it does not would send
  // the reader looking for a deleted operation that is fine.
  if (error && !tx) return <ErrorNote error={error} onRetry={refetch} />;
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
      await editTx({
        id,
        body: {
          merchant: merchant.trim() || null,
          category_id: categoryId,
          learn: isMono && learn,
          is_transfer: isTransfer,
          event_id: eventId,
          tags,
          importance,
          ...(looksTransfer ? { real_category_id: realCategoryId } : {}),
        },
      }).unwrap();
      setLearn(false);
      toast.success(t("tx.saved"));
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

          <TxAiBlock tx={tx} />

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
                {tx.bank_description && tx.bank_description.trim() !== (tx.merchant ?? "").trim() && (
                  <span className="ai-block-sub">{t("tx.bankDescription")} «{tx.bank_description}»</span>
                )}
                {tx.name_locked ? (
                  <span className="ai-block-sub" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {"🔒 "}{t(tx.name_locked === 2 ? "tx.nameRemembered" : "tx.nameLocked")}{" "}
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
                          style={on ? { borderColor: catColor(m.color), background: `color-mix(in srgb, ${catColor(m.color)} 14%, transparent)`, color: catColor(m.color) } : undefined}
                          onClick={() => setImportance(lv)}>
                          <span className="d" style={{ background: catColor(m.color) }} />{t(m.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                  {/* docs/JEV.md — Jev's per-row proposal, only where it DIFFERS from what the
                      category already says (otherwise the button would change nothing), and only
                      into the form: saving it is still the person's click. */}
                  {importance == null && tx.ai_importance && tx.ai_importance !== (tx.category_importance ?? "discretionary") && (
                    <span className="judge-suggest">
                      {t("tx.impSuggest", { level: t(IMPORTANCE_META[tx.ai_importance].labelKey) })}
                      <button type="button" className="btn ghost" onClick={() => setImportance(tx.ai_importance!)}>{t("tx.impSuggestTake")}</button>
                    </span>
                  )}
                </div>
              )}

              {/* Tags are extra CATEGORIES on one row (at most three): «Подарунки» on a restaurant
                  bill. The chosen ones and the «+» sit on one line, so an empty field is one small
                  control rather than a label, a counter and a disclosure stacked up. */}
              <div className="stack" style={{ gap: 6 }}>
                <span className="label">{t("tx.label.tags")} · {tags.length}/3</span>
                <div className="tag-line">
                  {tags.map((tid) => {
                    const c = orderedCats.find((x) => x.id === tid);
                    if (!c) return null;
                    return (
                      <button key={tid} type="button" className="tag-chip on" aria-label={t("tx.tagRemove", { name: c.name })} onClick={() => toggleTag(tid)}>
                        <span className="d" style={{ background: catColor(c.color ?? "var(--muted)") }} />
                        {c.name}
                        <span className="tag-chip-x" aria-hidden>×</span>
                      </button>
                    );
                  })}
                  {tags.length < 3 && (
                    <button type="button" className={`tag-add ${tagOpen ? "open" : ""}`} aria-expanded={tagOpen} onClick={() => setTagOpen(!tagOpen)}>
                      <Icon name="plus" size={13} />{t("tx.tagsPick")}
                    </button>
                  )}
                </div>
                {tagOpen && tags.length < 3 && (
                  <div className="tag-panel">
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
                                    <span className="d" style={{ background: catColor(c.color ?? "var(--muted)") }} />
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
                  </div>
                )}
              </div>

              {/* §TAX-BASE — a person's decision about the row, so it lives in the editor. It used to
                  sit inside the AI block, where «Робоча операція» read as something the AI had
                  concluded — and nobody could tell what it was for. */}
              <BusinessToggle txId={id} value={tx.is_business ?? null}
                proposal={tx.ai_business} accountBusiness={tx.account_business} />

              {/* Switches, not checkboxes buried in a sentence: a title that says WHAT, a line that
                  says what it changes. The old «Застосувати до всіх таких і **запамʼятати** — …» put
                  the control in front of a paragraph and made the reader parse it to find out. */}
              <div className="switch-list">
                <label className="switch-row">
                  <span className="switch-text">
                    <span className="switch-title">{t("tx.transferTitle")}</span>
                    <span className="switch-hint">{t("tx.transferHint2")}</span>
                  </span>
                  <input type="checkbox" role="switch" className="switch" checked={isTransfer} onChange={(e) => setIsTransfer(e.target.checked)} />
                </label>
                {isMono && (
                  <label className="switch-row">
                    <span className="switch-text">
                      <span className="switch-title">{t("tx.learnTitle")}</span>
                      <span className="switch-hint">{t("tx.learnHint2")}</span>
                    </span>
                    <input type="checkbox" role="switch" className="switch" checked={learn} onChange={(e) => setLearn(e.target.checked)} />
                  </label>
                )}
              </div>
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

function FactLine({ k, v, dot, mono }: { k: string; v: React.ReactNode; dot?: string | null; mono?: boolean }) {
  return (
    <div className="fact-line">
      <span className="fact-k">{k}</span>
      <span className={`fact-v ${mono ? "mono" : ""}`}>
        {dot && <span className="fact-dot" style={{ background: catColor(dot) }} />}
        {v}
      </span>
    </div>
  );
}
