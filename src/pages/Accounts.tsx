import { useState } from "react";
import { useT } from "../i18n/index.ts";
import {
  useGetAccountsQuery,
  useGetArchivedAccountsQuery,
  useGetFundsQuery,
  useGetAccountsHistoryQuery,
  useGetRatesQuery,
  useEditManualAccountMutation,
  useSetAccountTitleMutation,
  useSetAccountMetaMutation,
  useSetAccountActiveMutation,
  useDeleteAccountMutation,
} from "../store/api.ts";
import { Money } from "../components/ui/Money.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { Select } from "../components/ui/Select.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { Sparkline } from "../components/ui/Sparkline.tsx";
import { NetworthCard } from "../components/stats/NetworthCard.tsx";
import { AddAccountModal } from "../components/accounts/AddAccountModal.tsx";
import { toUAHMinor, formatMinor } from "../lib/format.ts";
import { errText } from "../lib/errors.ts";
import { toast } from "../lib/toast.ts";
import { accountTypeLabel } from "../lib/merchant.ts";
import { currencySign } from "../lib/format.ts";
import type { Account } from "../../shared/types.ts";

// ₴-величина рахунку для сортування/підсумків — дзеркалить `shown` у картці (кредитка = власні).
// Від'ємне НЕ затискаємо: кредитка в боргу має власних коштів менше нуля, і саме це число
// беруть подушка/нетворт на сервері. Затиск `Math.max(own, 0)` тут давав розбіг між сумою на
// цій сторінці й подушкою на Головній — те саме число в двох місцях означало різне.
function uahValue(a: Account, rates: Record<string, number>): number {
  const limit = a.credit_limit ?? 0;
  const own = (a.balance ?? 0) - limit;
  const shown = limit > 0 ? own : (a.balance ?? 0);
  const code = a.currency_code ?? 980;
  return code !== 980 ? (toUAHMinor(shown, code, rates) ?? 0) : shown;
}

export function Accounts() {
  const t = useT();
  const { data: accounts, isLoading } = useGetAccountsQuery();
  const { data: ratesData } = useGetRatesQuery();
  const { data: histData } = useGetAccountsHistoryQuery();
  const rates = ratesData?.rates ?? {};
  const history = histData?.history ?? {};
  const [adding, setAdding] = useState(false);
  const [hideZero, setHideZero] = useState(false);

  if (isLoading) return <AccountsSkeleton />;

  // Нульові ховаємо лише за тумблером; кредитку з боргом/лімітом лишаємо (там є що показати).
  const nonZero = (a: Account) => Math.abs(uahValue(a, rates)) >= 100 || (a.credit_limit ?? 0) > 0;
  const src = (accounts ?? []).filter((a) => !hideZero || nonZero(a));
  const zeroCount = (accounts ?? []).length - (accounts ?? []).filter(nonZero).length;

  // §P2.2 — групуємо по ІНСТИТУЦІЇ (`provider`), а не по типу: усі рахунки одного банку (картки
  // + банки + ФОП) під спільним заголовком. Рахунки з реального банку йдуть у групу цього банку;
  // ручні/CSV (`provider` не банк) лишаються в типових бакетах, бо це не одна установа.
  const groups = buildGroups(src, rates, t);
  const curRows = currencyRows(accounts ?? [], rates);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("nav.accounts")}</div>
          <div className="sub">{t("acct.sub")}</div>
        </div>
        <div className="page-head-actions">
          {zeroCount > 0 && (
            <button className="pill-toggle" onClick={() => setHideZero((z) => !z)}>
              <Icon name={hideZero ? "check" : "folder"} size={14} />
              {hideZero ? t("acct.showZero") : t("acct.hideZero", { count: zeroCount })}
            </button>
          )}
          <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> {t("acct.add")}</button>
        </div>
      </div>

      <FundsOverview />

      {!accounts?.length && (
        <div className="card empty" style={{ marginBottom: 16 }}>
          {t("acct.empty")}
        </div>
      )}

      {/* Секції йдуть у кілька колонок (`.acct-sections`), а не стовпчиком: секція з двома
          картками раніше займала лише лівий край сітки, і сторінка тягнулась удвічі довше.
          Рахунки — головне на сторінці, тож на ВСЮ ширину; підсумки-довідники (валюти,
          історія, архів) ідуть під ними, а не сайдбаром, який відрізав би від рахунків 320px. */}
      <div className="acct-sections">
        {groups.map((g) => (
          <Section key={g.key} title={g.label} accounts={g.accounts} rates={rates} history={history} />
        ))}
      </div>

      {curRows.length >= 2 && (
        <section className="acct-tail">
          <div className="section-head"><h2>{t("acct.currencyBreakdown")}</h2><span className="label">{t("acct.uahEquiv")}</span></div>
          <CurrencyBreakdown rows={curRows} />
        </section>
      )}

      {(accounts?.length ?? 0) > 1 && (
        <section className="acct-tail">
          <div className="section-head"><h2>{t("acct.capitalHistory")}</h2><span className="label">{t("acct.networthComposition")}</span></div>
          <NetworthCard months={12} />
        </section>
      )}

      <ArchivedSection rates={rates} />

      {adding && <AddAccountModal onClose={() => setAdding(false)} />}
    </>
  );
}

// Розподіл активів по валютах (₴-величина кожної валюти) — швидка відповідь «скільки в чому».
// Розрахунок винесено окремо, бо сторінка мусить знати про наявність рядків ДО рендера рейла.
function currencyRows(accounts: Account[], rates: Record<string, number>): [number, number][] {
  const byCur = new Map<number, number>();
  for (const a of accounts) {
    const code = a.currency_code ?? 980;
    const v = uahValue(a, rates);
    if (v > 0) byCur.set(code, (byCur.get(code) ?? 0) + v);
  }
  return [...byCur.entries()].sort((a, b) => b[1] - a[1]);
}

// Human names for real bank providers (proper nouns — not translated). Anything not here
// (manual/csv/null) is not a single institution and falls back to type buckets below.
const BANK_LABEL: Record<string, string> = { mono: "Monobank", privat: "PrivatBank" };

function accountSubtotal(accts: Account[], rates: Record<string, number>): number {
  return accts.reduce((s, a) => s + uahValue(a, rates), 0);
}

interface AcctGroup { key: string; label: string; accounts: Account[] }

// §P2.2 — group by institution: one group per real bank (all its account types together),
// then the non-bank type buckets. Ordered by ₴ subtotal so the primary bank sits on top.
function buildGroups(src: Account[], rates: Record<string, number>, t: ReturnType<typeof useT>): AcctGroup[] {
  const banks = new Map<string, Account[]>();
  const rest: Account[] = [];
  for (const a of src) {
    if (a.provider && BANK_LABEL[a.provider]) {
      const arr = banks.get(a.provider) ?? [];
      arr.push(a);
      banks.set(a.provider, arr);
    } else rest.push(a);
  }
  const jars = rest.filter((a) => a.type === "jar");
  const fop = rest.filter((a) => a.type === "fop");
  const manual = rest.filter((a) => a.type !== "jar" && a.type !== "fop");
  const groups: AcctGroup[] = [
    ...[...banks.entries()].map(([key, accounts]) => ({ key, label: BANK_LABEL[key], accounts })),
    { key: "manual", label: t("acct.sec.manual"), accounts: manual },
    { key: "fop", label: t("acct.sec.fop"), accounts: fop },
    { key: "jars", label: t("acct.sec.jars"), accounts: jars },
  ].filter((g) => g.accounts.length);
  return groups.sort((a, b) => accountSubtotal(b.accounts, rates) - accountSubtotal(a.accounts, rates));
}

function CurrencyBreakdown({ rows }: { rows: [number, number][] }) {
  if (rows.length < 2) return null;
  const total = rows.reduce((s, [, v]) => s + v, 0) || 1;
  const COLORS = ["var(--accent)", "var(--c-teal)", "var(--c-ochre)", "var(--c-plum)", "var(--c-pine)"];
  // Заголовок несе `section-head` сторінки — тут лише смуга + легенда (інакше два заголовки поспіль).
  return (
    <div className="card cur-split">
      <div className="cur-split-bar">
        {rows.map(([code, v], i) => (
          <span key={code} style={{ width: `${(v / total) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${currencySign(code)}: ${formatMinor(v, { decimals: false })} ₴`} />
        ))}
      </div>
      <div className="cur-split-legend">
        {rows.map(([code, v], i) => (
          <span key={code} className="cs-item">
            <span className="d" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="cs-cur">{currencySign(code)}</span>
            <span className="cs-val">{formatMinor(v, { decimals: false })} ₴</span>
            <span className="cs-pct muted">{Math.round((v / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// §R3: композиція коштів = канон fundsBreakdown (той самий, що в Пораднику). Не рахуємо на
// клієнті, щоб «подушка/борг/інвестиції» тут не розійшлись із Порадником.
function FundsOverview() {
  const t = useT();
  const { data: f } = useGetFundsQuery();
  if (!f) return null;
  // Повний нетворт (= пігулка «власних» = summary.totalUAH): подушка + інвестиції − борг.
  // Показуємо ЙОГО як герой, а консервативний (без інвестицій, §R3) — окремим підписом,
  // щоб дві різні цифри «власних» не збивали з пантелику (раніше −31 966 vs 30 755).
  const fullNet = f.cushion + f.investment - f.debt;
  const parts = [
    { key: "cushion", label: t("acct.cushion"), val: f.cushion, color: "var(--pos)" },
    { key: "investment", label: t("acct.investments"), val: f.investment, color: "var(--c-plum)" },
    { key: "debt", label: t("acct.debt"), val: f.debt, color: "var(--neg)" },
  ] as const;
  const barTotal = f.cushion + f.investment + f.debt || 1;
  const hasBar = f.cushion + f.investment + f.debt > 0;
  return (
    <div className="card funds-overview">
      <div className="funds-stats">
        <div className="funds-stat net">
          <span className="fs-lbl">{t("acct.netCapital")}</span>
          <span className={`fs-val num-hero ${fullNet < 0 ? "neg" : ""}`}><Money minor={fullNet} decimals={false} /></span>
          {f.investment > 0 && (
            <span className="fs-sub">{t("acct.withoutInvestments")}: <Money minor={f.net} decimals={false} /></span>
          )}
        </div>
        {parts.map((p) => (p.val > 0 || p.key === "cushion") && (
          <div key={p.key} className="funds-stat">
            <span className="fs-lbl"><span className="d" style={{ background: p.color }} />{p.label}</span>
            <span className={`fs-val ${p.key === "debt" && p.val > 0 ? "neg" : ""}`}>{p.key === "debt" && p.val > 0 ? "−" : ""}<Money minor={p.val} decimals={false} /></span>
          </div>
        ))}
      </div>
      {hasBar && (
        <div className="funds-bar">
          {parts.map((p) => p.val > 0 && (
            <span key={p.key} style={{ width: `${(p.val / barTotal) * 100}%`, background: p.color }} title={`${p.label}: ${formatMinor(p.val, { decimals: false })} ₴`} />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, accounts, rates, history }: {
  title: string; accounts: Account[]; rates: Record<string, number>; history: Record<string, number[]>;
}) {
  if (!accounts.length) return null;
  // Сортуємо за ₴-величиною спадно — найбільші рахунки вгорі.
  const sorted = [...accounts].sort((a, b) => uahValue(b, rates) - uahValue(a, rates));
  const subtotal = sorted.reduce((s, a) => s + uahValue(a, rates), 0);
  return (
    <section className="acct-sec">
      <div className="section-head">
        <h2>{title}</h2>
        <span className="acct-sec-sum">≈ {formatMinor(subtotal, { decimals: false })} ₴</span>
      </div>
      <div className="acct-grid">
        {sorted.map((a) => <AccountCard key={a.id} a={a} rates={rates} spark={history[a.id]} />)}
      </div>
    </section>
  );
}

function last4(title: string | null): string | null {
  const m = title?.match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

// Колір-акцент за типом рахунку (замість фонів «фізичних карток»).
const TYPE_COLOR: Record<string, string> = {
  black: "var(--ink)", white: "#8a94a6", platinum: "#8a94a6", fop: "var(--c-pine)",
  jar: "var(--c-teal)", cash: "var(--c-ochre)", manual_card: "var(--accent)", crypto: "var(--c-plum)",
};

function AccountCard({ a, rates, spark }: {
  a: Account; rates: Record<string, number>; spark?: number[];
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const kind = a.type ?? "manual";
  // Per-account flags (were section-level before institution grouping): manual accounts allow
  // balance/title edit; jars are visually muted and renameable even when synced from a bank.
  const muted = a.type === "jar";
  const editable = a.is_manual === 1;
  const renameable = a.type === "jar";
  const cls = ["acct2", muted ? "muted-acct" : ""].join(" ");
  const pan = last4(a.title);
  const credit = (a.credit_limit ?? 0) > 0;
  const limit = a.credit_limit ?? 0;
  const own = (a.balance ?? 0) - limit;
  // Власні кошти кредитки можуть бути від'ємними — показуємо як є (див. `uahValue` вище).
  // Блок «Використано / Ліміт» нижче лишається: він несе ліміт і метр, чого сама сума не каже.
  const shown = credit ? own : (a.balance ?? 0);
  const usedCredit = credit && own < 0 ? -own : 0;
  const code = a.currency_code ?? 980;
  const color = TYPE_COLOR[kind] ?? "var(--muted)";

  // ≈ у ₴ для валютних рахунків/банок (курс з app_state.rates).
  const uah = code !== 980 ? toUAHMinor(shown, code, rates) : null;

  const showManualTitle = a.type === "cash" || a.type === "manual_card" || a.type === "crypto";
  const title = a.type === "jar" || showManualTitle ? (a.title || accountTypeLabel(kind)) : (accountTypeLabel(kind) ?? kind);
  const subLabel = credit ? t("acct.ownFunds")
    : a.type === "jar" ? t("acct.saved")
    : a.type === "crypto" ? t("acct.manualEstimate")
    : a.type === "cash" ? t("acct.cash")
    : a.is_manual ? t("acct.manualBalance")
    : t("acct.onAccount");

  const isInvestment = a.role === "investment";

  if (editing) return <AccountEditor a={a} onClose={() => setEditing(false)} cls={cls} manual={!!editable} renameable={!!renameable} />;

  return (
    <div className={cls} style={{ "--acct-color": color } as React.CSSProperties}>
      <div className="acct2-head">
        <span className="acct2-badge" style={{ background: color }} />
        <span className="acct2-title">{title}</span>
        {isInvestment && <span className="acct2-role" title={t("acct.investmentBadgeTitle")}>{t("acct.investmentBadge")}</span>}
        {pan && a.type !== "jar" && <span className="acct2-pan">·· {pan}</span>}
        <button className="acct2-edit" onClick={() => setEditing(true)} aria-label={t("acct.settings")}>
          <Icon name="edit" size={14} />
        </button>
      </div>
      <div className="acct2-sublabel">{subLabel}</div>
      <div className="acct2-bal"><Money minor={shown} currency={code} /></div>
      {uah != null && <div className="acct2-fx">≈ {formatMinor(uah, { decimals: false })} ₴</div>}
      {spark && spark.length >= 2 && !spark.every((v) => v === spark[0]) && (
        <div className="acct2-spark" title={t("acct.trend6mo")}><Sparkline values={spark} width={220} height={26} goodUp /></div>
      )}
      {a.ai_note && <div className="acct2-note" title={a.ai_note}>{a.ai_note}</div>}
      {credit && (
        <div className="acct2-credit">
          <div className="acct2-credit-row">
            <span>{t("acct.used")} <b><Money minor={usedCredit} decimals={false} /></b></span>
            <span className="muted">{t("acct.limit")} <Money minor={limit} decimals={false} /></span>
          </div>
          <div className="credit-meter"><span style={{ width: `${limit ? Math.min(100, (usedCredit / limit) * 100) : 0}%` }} /></div>
          {a.payment_day != null && (
            <div className="acct2-credit-terms">
              <Icon name="calendar" size={12} /> {t("acct.paymentDue", { day: a.payment_day })}
              {a.min_payment ? <> {t("acct.minPaymentPrefix")} {formatMinor(a.min_payment, { decimals: false })} ₴</> : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// §R3: єдиний редактор рахунку — роль (ліквідний/інвестиційний) + опис для AI для БУДЬ-ЯКОГО
// рахунку; додатково назва (банки/ручні) й баланс (ручні); архів/видалення внизу.
function AccountEditor({ a, onClose, cls, manual, renameable }: {
  a: Account; onClose: () => void; cls: string; manual: boolean; renameable: boolean;
}) {
  const t = useT();
  const ROLE_OPTIONS = [
    { value: "liquid", label: t("acct.roleLiquid") },
    { value: "investment", label: t("acct.roleInvestment") },
  ];
  const [editAccount] = useEditManualAccountMutation();
  const [setTitle] = useSetAccountTitleMutation();
  const [setMeta, { isLoading }] = useSetAccountMetaMutation();
  const [setActive] = useSetAccountActiveMutation();
  const [deleteAccount] = useDeleteAccountMutation();
  const canTitle = manual || renameable;
  const [title, setTitleVal] = useState(a.title ?? "");
  const [balance, setBalance] = useState(((a.balance ?? 0) / 100).toString());
  const [role, setRole] = useState<"liquid" | "investment">(a.role === "investment" ? "investment" : "liquid");
  const [note, setNote] = useState(a.ai_note ?? "");
  const [confirmDel, setConfirmDel] = useState(false);
  const isCredit = (a.credit_limit ?? 0) > 0;
  const [stmtDay, setStmtDay] = useState(a.statement_day != null ? String(a.statement_day) : "");
  const [payDay, setPayDay] = useState(a.payment_day != null ? String(a.payment_day) : "");
  const [minPay, setMinPay] = useState(a.min_payment != null ? String(a.min_payment / 100) : "");

  async function save() {
    const dayVal = (s: string): number | null => { const n = Math.trunc(Number(s)); return s.trim() && n >= 1 && n <= 31 ? n : null; };
    await setMeta({
      id: a.id, role, ai_note: note,
      ...(isCredit ? {
        statement_day: dayVal(stmtDay),
        payment_day: dayVal(payDay),
        min_payment: minPay.trim() ? Math.round(Number(minPay.replace(",", ".")) * 100) : null,
      } : {}),
    }).unwrap();
    if (manual) {
      await editAccount({ id: a.id, title: title.trim() || undefined, balance: Math.round(Number(balance.replace(",", ".")) * 100) }).unwrap();
    } else if (renameable && title.trim() && title.trim() !== (a.title ?? "")) {
      await setTitle({ id: a.id, title: title.trim() }).unwrap();
    }
    onClose();
  }

  async function archive() {
    try { await setActive({ id: a.id, active: false }).unwrap(); toast.success(t("acct.archivedToast")); onClose(); }
    catch (e) { toast.error(errText(e)); }
  }
  async function remove() {
    try { await deleteAccount(a.id).unwrap(); toast.success(t("acct.deletedToast")); onClose(); }
    catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className={cls} style={{ padding: 14 }}>
      <div className="acct-edit-form">
        {canTitle && <input value={title} onChange={(e) => setTitleVal(e.target.value)} placeholder={t("acct.namePlaceholder")} />}
        {manual && <input type="number" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder={t("acct.balancePlaceholder")} />}
        <Select value={role} options={ROLE_OPTIONS} onChange={(v) => setRole(v as "liquid" | "investment")} />
        <textarea className="acct-note-input" value={note} rows={2} maxLength={280}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("acct.notePlaceholder")} />
        {isCredit && (
          <div className="credit-terms">
            <div className="ct-title">{t("acct.creditTermsTitle")} <span className="muted">{t("acct.creditTermsHint")}</span></div>
            <div className="ct-grid">
              <label>{t("acct.statement")}<input type="number" inputMode="numeric" min={1} max={31} value={stmtDay} onChange={(e) => setStmtDay(e.target.value)} placeholder={t("acct.dayPlaceholder")} /></label>
              <label>{t("acct.paymentBy")}<input type="number" inputMode="numeric" min={1} max={31} value={payDay} onChange={(e) => setPayDay(e.target.value)} placeholder={t("acct.dayPlaceholder")} /></label>
              <label>{t("acct.minPaymentLabel")}<input type="number" inputMode="decimal" value={minPay} onChange={(e) => setMinPay(e.target.value)} placeholder="₴" /></label>
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={save} disabled={isLoading}>{t("common.save")}</button>
          <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
        </div>
        <div className="acct-danger">
          <button className="btn ghost sm" onClick={archive}><Icon name="folder" size={13} /> {t("acct.archiveBtn")}</button>
          {a.is_manual === 1 && (
            confirmDel
              ? <button className="btn danger sm" onClick={remove}>{t("acct.deleteConfirm")}</button>
              : <button className="btn ghost sm danger-text" onClick={() => setConfirmDel(true)}>{t("common.delete")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// Архів (is_active=0): згорнута секція з відновленням. Схований рахунок не в підсумках/подушці.
function ArchivedSection({ rates }: { rates: Record<string, number> }) {
  const t = useT();
  const { data } = useGetArchivedAccountsQuery();
  const [setActive] = useSetAccountActiveMutation();
  const [open, setOpen] = useState(false);
  if (!data?.length) return null;
  return (
    <section style={{ marginTop: 8 }}>
      <div className="section-head">
        <h2>{t("acct.archiveTitle")}</h2>
        <button className="btn ghost label" onClick={() => setOpen((o) => !o)}>{open ? t("acct.collapse") : t("acct.hiddenCount", { n: data.length })}</button>
      </div>
      {open && (
        <div className="acct-grid">
          {data.map((a) => {
            const code = a.currency_code ?? 980;
            const uah = code !== 980 ? uahValue(a, rates) : null;
            return (
              <div key={a.id} className="acct2 muted-acct archived-acct">
                <div className="acct2-head"><span className="acct2-title">{a.title || accountTypeLabel(a.type ?? "manual")}</span></div>
                <div className="acct2-bal"><Money minor={a.balance ?? 0} currency={code} /></div>
                {uah != null && <div className="acct2-fx">≈ {formatMinor(uah, { decimals: false })} ₴</div>}
                <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setActive({ id: a.id, active: true })}>{t("acct.restore")}</button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Скелет сторінки Рахунків: смуга огляду + дві секції карток.
function AccountsSkeleton() {
  const t = useT();
  return (
    <div aria-hidden="true">
      <div className="page-head">
        <div><div className="greet">{t("nav.accounts")}</div><div className="sub">{t("acct.sub")}</div></div>
      </div>
      <div className="card funds-overview" style={{ marginBottom: 16 }}>
        <div className="funds-stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="funds-stat"><Skeleton w={90} h={11} /><Skeleton w={120} h={24} style={{ marginTop: 10 }} /></div>
          ))}
        </div>
        <Skeleton w="100%" h={10} style={{ marginTop: 16, borderRadius: 999 }} />
      </div>
      {[0, 1].map((s) => (
        <div key={s}>
          <div className="section-head"><Skeleton w={140} h={18} /></div>
          <div className="acct-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="acct2"><Skeleton w={100} h={13} /><Skeleton w={60} h={11} style={{ marginTop: 12 }} /><Skeleton w={130} h={26} style={{ marginTop: 10 }} /></div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
