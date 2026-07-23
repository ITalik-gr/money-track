import { useState } from "react";
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
import { Money } from "../components/Money.tsx";
import { Icon } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Sparkline } from "../components/Sparkline.tsx";
import { NetworthCard } from "../components/NetworthCard.tsx";
import { AddAccountModal } from "../components/AddAccountModal.tsx";
import { toUAHMinor, formatMinor } from "../lib/format.ts";
import { errText } from "../lib/errors.ts";
import { toast } from "../lib/toast.ts";
import { accountTypeLabel } from "../lib/merchant.ts";
import { currencySign } from "../lib/format.ts";
import type { Account } from "../../shared/types.ts";

// ₴-величина рахунку для сортування/підсумків — дзеркалить `shown` у картці (кредитка = власні).
function uahValue(a: Account, rates: Record<string, number>): number {
  const limit = a.credit_limit ?? 0;
  const own = (a.balance ?? 0) - limit;
  const shown = limit > 0 ? Math.max(own, 0) : (a.balance ?? 0);
  const code = a.currency_code ?? 980;
  return code !== 980 ? (toUAHMinor(shown, code, rates) ?? 0) : shown;
}

export function Accounts() {
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

  const isCard = (t: string | null) => t === "black" || t === "white" || t === "platinum";
  const uahCards = src.filter((a) => isCard(a.type) && a.currency_code === 980);
  const fxCards = src.filter((a) => isCard(a.type) && a.currency_code !== 980);
  const fop = src.filter((a) => a.type === "fop");
  const manual = src.filter((a) => a.type === "cash" || a.type === "manual_card" || a.type === "crypto");
  const jars = src.filter((a) => a.type === "jar");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Рахунки</div>
          <div className="sub">Усі картки, готівка й накопичення в одному місці.</div>
        </div>
        <div className="page-head-actions">
          {zeroCount > 0 && (
            <button className="pill-toggle" onClick={() => setHideZero((z) => !z)}>
              <Icon name={hideZero ? "check" : "folder"} size={14} />
              {hideZero ? "Показати нульові" : `Сховати нульові (${zeroCount})`}
            </button>
          )}
          <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Додати рахунок</button>
        </div>
      </div>

      <FundsOverview />
      <CurrencyBreakdown accounts={accounts ?? []} rates={rates} />

      {!accounts?.length && (
        <div className="card empty" style={{ marginBottom: 16 }}>
          Рахунків із Monobank ще немає. Підтягни їх у «Налаштуваннях» — або додай крипто/готівку вручну кнопкою вгорі.
        </div>
      )}

      <Section title="Гривневі картки" accounts={uahCards} rates={rates} history={history} />
      <Section title="Валютні картки" accounts={fxCards} rates={rates} history={history} />
      <Section title="ФОП" accounts={fop} rates={rates} history={history} />
      <Section title="Готівка та ручні" accounts={manual} rates={rates} history={history} manual />
      <Section title="Банки (накопичення)" accounts={jars} rates={rates} history={history} muted renameable />

      {(accounts?.length ?? 0) > 1 && (
        <section style={{ marginTop: 4 }}>
          <div className="section-head"><h2>Історія капіталу</h2><span className="label">склад нетворту 12 міс</span></div>
          <NetworthCard months={12} />
        </section>
      )}

      <ArchivedSection rates={rates} />

      {adding && <AddAccountModal onClose={() => setAdding(false)} />}
    </>
  );
}

// Розподіл активів по валютах (₴-величина кожної валюти) — швидка відповідь «скільки в чому».
function CurrencyBreakdown({ accounts, rates }: { accounts: Account[]; rates: Record<string, number> }) {
  const byCur = new Map<number, number>();
  for (const a of accounts) {
    const code = a.currency_code ?? 980;
    const v = uahValue(a, rates);
    if (v > 0) byCur.set(code, (byCur.get(code) ?? 0) + v);
  }
  const rows = [...byCur.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length < 2) return null;
  const total = rows.reduce((s, [, v]) => s + v, 0) || 1;
  const COLORS = ["var(--accent)", "var(--c-teal)", "var(--c-ochre)", "var(--c-plum)", "var(--c-pine)"];
  return (
    <div className="card cur-split">
      <div className="cur-split-head"><span className="label">Розподіл по валютах</span><span className="muted" style={{ fontSize: 12 }}>у ₴-еквіваленті</span></div>
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
  const { data: f } = useGetFundsQuery();
  if (!f) return null;
  // Повний нетворт (= пігулка «власних» = summary.totalUAH): подушка + інвестиції − борг.
  // Показуємо ЙОГО як герой, а консервативний (без інвестицій, §R3) — окремим підписом,
  // щоб дві різні цифри «власних» не збивали з пантелику (раніше −31 966 vs 30 755).
  const fullNet = f.cushion + f.investment - f.debt;
  const parts = [
    { key: "cushion", label: "Ліквідна подушка", val: f.cushion, color: "var(--pos)" },
    { key: "investment", label: "Інвестиції", val: f.investment, color: "var(--c-plum)" },
    { key: "debt", label: "Борг", val: f.debt, color: "var(--neg)" },
  ] as const;
  const barTotal = f.cushion + f.investment + f.debt || 1;
  const hasBar = f.cushion + f.investment + f.debt > 0;
  return (
    <div className="card funds-overview">
      <div className="funds-stats">
        <div className="funds-stat net">
          <span className="fs-lbl">Чистий капітал</span>
          <span className={`fs-val num-hero ${fullNet < 0 ? "neg" : ""}`}><Money minor={fullNet} decimals={false} /></span>
          {f.investment > 0 && (
            <span className="fs-sub">без інвестицій: <Money minor={f.net} decimals={false} /></span>
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

function Section({ title, accounts, rates, history, muted, manual, renameable }: {
  title: string; accounts: Account[]; rates: Record<string, number>; history: Record<string, number[]>; muted?: boolean; manual?: boolean; renameable?: boolean;
}) {
  if (!accounts.length) return null;
  // Сортуємо за ₴-величиною спадно — найбільші рахунки вгорі (раніше — довільний порядок за типом).
  const sorted = [...accounts].sort((a, b) => uahValue(b, rates) - uahValue(a, rates));
  const subtotal = sorted.reduce((s, a) => s + uahValue(a, rates), 0);
  return (
    <>
      <div className="section-head">
        <h2>{title}</h2>
        <span className="acct-sec-sum">≈ {formatMinor(subtotal, { decimals: false })} ₴</span>
      </div>
      <div className="acct-grid">
        {sorted.map((a) => (
          <AccountCard key={a.id} a={a} rates={rates} spark={history[a.id]} muted={muted}
            editable={manual && !!a.is_manual} renameable={renameable} />
        ))}
      </div>
    </>
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

function AccountCard({ a, rates, spark, muted, editable, renameable }: {
  a: Account; rates: Record<string, number>; spark?: number[]; muted?: boolean; editable?: boolean; renameable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const kind = a.type ?? "manual";
  const cls = ["acct2", muted ? "muted-acct" : ""].join(" ");
  const pan = last4(a.title);
  const credit = (a.credit_limit ?? 0) > 0;
  const limit = a.credit_limit ?? 0;
  const own = (a.balance ?? 0) - limit;
  const shown = credit ? Math.max(own, 0) : (a.balance ?? 0);
  const usedCredit = credit && own < 0 ? -own : 0;
  const code = a.currency_code ?? 980;
  const color = TYPE_COLOR[kind] ?? "var(--muted)";

  // ≈ у ₴ для валютних рахунків/банок (курс з app_state.rates).
  const uah = code !== 980 ? toUAHMinor(shown, code, rates) : null;

  const showManualTitle = a.type === "cash" || a.type === "manual_card" || a.type === "crypto";
  const title = a.type === "jar" || showManualTitle ? (a.title || accountTypeLabel(kind)) : (accountTypeLabel(kind) ?? kind);
  const subLabel = credit ? "власних коштів"
    : a.type === "jar" ? "накопичено"
    : a.type === "crypto" ? "оцінка (вручну)"
    : a.type === "cash" ? "готівкою"
    : a.is_manual ? "баланс (вручну)"
    : "на рахунку";

  const isInvestment = a.role === "investment";

  if (editing) return <AccountEditor a={a} onClose={() => setEditing(false)} cls={cls} manual={!!editable} renameable={!!renameable} />;

  return (
    <div className={cls} style={{ "--acct-color": color } as React.CSSProperties}>
      <div className="acct2-head">
        <span className="acct2-badge" style={{ background: color }} />
        <span className="acct2-title">{title}</span>
        {isInvestment && <span className="acct2-role" title="Інвестиційний рахунок — не входить у ліквідну подушку">інвест</span>}
        {pan && a.type !== "jar" && <span className="acct2-pan">·· {pan}</span>}
        <button className="acct2-edit" onClick={() => setEditing(true)} aria-label="Налаштування рахунку">
          <Icon name="edit" size={14} />
        </button>
      </div>
      <div className="acct2-sublabel">{subLabel}</div>
      <div className="acct2-bal"><Money minor={shown} currency={code} /></div>
      {uah != null && <div className="acct2-fx">≈ {formatMinor(uah, { decimals: false })} ₴</div>}
      {spark && spark.length >= 2 && !spark.every((v) => v === spark[0]) && (
        <div className="acct2-spark" title="Тренд балансу за 6 міс"><Sparkline values={spark} width={220} height={26} goodUp /></div>
      )}
      {a.ai_note && <div className="acct2-note" title={a.ai_note}>{a.ai_note}</div>}
      {credit && (
        <div className="acct2-credit">
          <div className="acct2-credit-row">
            <span>використано <b><Money minor={usedCredit} decimals={false} /></b></span>
            <span className="muted">ліміт <Money minor={limit} decimals={false} /></span>
          </div>
          <div className="credit-meter"><span style={{ width: `${limit ? Math.min(100, (usedCredit / limit) * 100) : 0}%` }} /></div>
          {a.payment_day != null && (
            <div className="acct2-credit-terms">
              <Icon name="calendar" size={12} /> платіж до {a.payment_day} числа
              {a.min_payment ? <> · мін. {formatMinor(a.min_payment, { decimals: false })} ₴</> : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// §R3: єдиний редактор рахунку — роль (ліквідний/інвестиційний) + опис для AI для БУДЬ-ЯКОГО
// рахунку; додатково назва (банки/ручні) й баланс (ручні); архів/видалення внизу.
const ROLE_OPTIONS = [
  { value: "liquid", label: "Ліквідний (подушка)" },
  { value: "investment", label: "Інвестиційний (не подушка)" },
];
function AccountEditor({ a, onClose, cls, manual, renameable }: {
  a: Account; onClose: () => void; cls: string; manual: boolean; renameable: boolean;
}) {
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
    try { await setActive({ id: a.id, active: false }).unwrap(); toast.success("Рахунок у архіві"); onClose(); }
    catch (e) { toast.error(errText(e)); }
  }
  async function remove() {
    try { await deleteAccount(a.id).unwrap(); toast.success("Рахунок видалено"); onClose(); }
    catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className={cls} style={{ padding: 14 }}>
      <div className="acct-edit-form">
        {canTitle && <input value={title} onChange={(e) => setTitleVal(e.target.value)} placeholder="Назва" />}
        {manual && <input type="number" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="Баланс" />}
        <Select value={role} options={ROLE_OPTIONS} onChange={(v) => setRole(v as "liquid" | "investment")} />
        <textarea className="acct-note-input" value={note} rows={2} maxLength={280}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Опис для AI (напр. «USDT — інвестиції, чіпати лише в крайньому разі»)" />
        {isCredit && (
          <div className="credit-terms">
            <div className="ct-title">Умови кредитки <span className="muted">— нагадаємо про платіж за 3 дні</span></div>
            <div className="ct-grid">
              <label>Виписка<input type="number" inputMode="numeric" min={1} max={31} value={stmtDay} onChange={(e) => setStmtDay(e.target.value)} placeholder="день" /></label>
              <label>Платіж до<input type="number" inputMode="numeric" min={1} max={31} value={payDay} onChange={(e) => setPayDay(e.target.value)} placeholder="день" /></label>
              <label>Мін. платіж<input type="number" inputMode="decimal" value={minPay} onChange={(e) => setMinPay(e.target.value)} placeholder="₴" /></label>
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={save} disabled={isLoading}>Зберегти</button>
          <button className="btn ghost" onClick={onClose}>Скасувати</button>
        </div>
        <div className="acct-danger">
          <button className="btn ghost sm" onClick={archive}><Icon name="folder" size={13} /> Архівувати</button>
          {a.is_manual === 1 && (
            confirmDel
              ? <button className="btn danger sm" onClick={remove}>Точно видалити?</button>
              : <button className="btn ghost sm danger-text" onClick={() => setConfirmDel(true)}>Видалити</button>
          )}
        </div>
      </div>
    </div>
  );
}

// Архів (is_active=0): згорнута секція з відновленням. Схований рахунок не в підсумках/подушці.
function ArchivedSection({ rates }: { rates: Record<string, number> }) {
  const { data } = useGetArchivedAccountsQuery();
  const [setActive] = useSetAccountActiveMutation();
  const [open, setOpen] = useState(false);
  if (!data?.length) return null;
  return (
    <section style={{ marginTop: 8 }}>
      <div className="section-head">
        <h2>Архів</h2>
        <button className="btn ghost label" onClick={() => setOpen((o) => !o)}>{open ? "згорнути" : `${data.length} схованих`}</button>
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
                <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setActive({ id: a.id, active: true })}>Відновити</button>
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
  return (
    <div aria-hidden="true">
      <div className="page-head">
        <div><div className="greet">Рахунки</div><div className="sub">Усі картки, готівка й накопичення в одному місці.</div></div>
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
