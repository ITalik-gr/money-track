import { useState } from "react";
import {
  useGetAccountsQuery,
  useGetSummaryQuery,
  useGetRatesQuery,
  useAddManualAccountMutation,
  useEditManualAccountMutation,
  useSetAccountTitleMutation,
  useSetAccountMetaMutation,
} from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { Icon } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import { toUAHMinor, formatMinor } from "../lib/format.ts";
import { accountTypeLabel } from "../lib/merchant.ts";
import type { Account } from "../../shared/types.ts";

const CURRENCIES: { code: number; label: string }[] = [
  { code: 980, label: "₴ UAH" },
  { code: 840, label: "$ USD" },
  { code: 978, label: "€ EUR" },
];

export function Accounts() {
  const { data: accounts, isLoading } = useGetAccountsQuery();
  const { data: summary } = useGetSummaryQuery();
  const { data: ratesData } = useGetRatesQuery();
  const rates = ratesData?.rates ?? {};

  if (isLoading) return <div className="empty">Завантаження…</div>;

  const isCard = (t: string | null) => t === "black" || t === "white" || t === "platinum";
  const uahCards = (accounts ?? []).filter((a) => isCard(a.type) && a.currency_code === 980);
  const fxCards = (accounts ?? []).filter((a) => isCard(a.type) && a.currency_code !== 980);
  const fop = (accounts ?? []).filter((a) => a.type === "fop");
  const manual = (accounts ?? []).filter((a) => a.type === "cash" || a.type === "manual_card" || a.type === "crypto");
  const jars = (accounts ?? []).filter((a) => a.type === "jar");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Рахунки</div>
          <div className="sub">Усі картки, готівка й накопичення в одному місці.</div>
        </div>
        {summary && (
          <div className="page-head-actions">
            <span className="date-pill">власних ≈ <Money minor={summary.totalUAH} decimals={false} /></span>
          </div>
        )}
      </div>

      {!accounts?.length && (
        <div className="card empty" style={{ marginBottom: 16 }}>
          Рахунків із Monobank ще немає. Підтягни їх у «Налаштуваннях» — або додай крипто/готівку вручну нижче.
        </div>
      )}

      <Section title="Гривневі картки" accounts={uahCards} rates={rates} />
      <Section title="Валютні картки" accounts={fxCards} rates={rates} />
      <Section title="ФОП" accounts={fop} rates={rates} />
      <Section title="Готівка та ручні" accounts={manual} rates={rates} manual />
      <Section title="Банки (накопичення)" accounts={jars} rates={rates} muted renameable />

      <AddManualAccount />
    </>
  );
}

function Section({ title, accounts, rates, muted, manual, renameable }: {
  title: string; accounts: Account[]; rates: Record<string, number>; muted?: boolean; manual?: boolean; renameable?: boolean;
}) {
  if (!accounts.length) return null;
  return (
    <>
      <div className="section-head"><h2>{title}</h2></div>
      <div className="acct-grid">
        {accounts.map((a) => (
          <AccountCard key={a.id} a={a} rates={rates} muted={muted}
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

function AccountCard({ a, rates, muted, editable, renameable }: {
  a: Account; rates: Record<string, number>; muted?: boolean; editable?: boolean; renameable?: boolean;
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
      {a.ai_note && <div className="acct2-note" title={a.ai_note}>{a.ai_note}</div>}
      {credit && (
        <div className="acct2-credit">
          <div className="acct2-credit-row">
            <span>використано <b><Money minor={usedCredit} decimals={false} /></b></span>
            <span className="muted">ліміт <Money minor={limit} decimals={false} /></span>
          </div>
          <div className="credit-meter"><span style={{ width: `${limit ? Math.min(100, (usedCredit / limit) * 100) : 0}%` }} /></div>
        </div>
      )}
    </div>
  );
}

// §R3: єдиний редактор рахунку — роль (ліквідний/інвестиційний) + опис для AI для БУДЬ-ЯКОГО
// рахунку; додатково назва (банки/ручні) й баланс (ручні). Опис читає порадник/репорти.
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
  const canTitle = manual || renameable;
  const [title, setTitleVal] = useState(a.title ?? "");
  const [balance, setBalance] = useState(((a.balance ?? 0) / 100).toString());
  const [role, setRole] = useState<"liquid" | "investment">(a.role === "investment" ? "investment" : "liquid");
  const [note, setNote] = useState(a.ai_note ?? "");

  async function save() {
    await setMeta({ id: a.id, role, ai_note: note }).unwrap();
    if (manual) {
      await editAccount({ id: a.id, title: title.trim() || undefined, balance: Math.round(Number(balance.replace(",", ".")) * 100) }).unwrap();
    } else if (renameable && title.trim() && title.trim() !== (a.title ?? "")) {
      await setTitle({ id: a.id, title: title.trim() }).unwrap();
    }
    onClose();
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
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={save} disabled={isLoading}>Зберегти</button>
          <button className="btn ghost" onClick={onClose}>Скасувати</button>
        </div>
      </div>
    </div>
  );
}

// Форма «+ додати рахунок вручну» — крипта / позамоно картка / готівка.
// Без цього власні кошти й runway неповні (usdt та інші активи ніде не враховані).
function AddManualAccount() {
  const [addAccount, { isLoading }] = useAddManualAccountMutation();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"manual_card" | "crypto">("crypto");
  const [title, setTitle] = useState("");
  const [currency, setCurrency] = useState(840);
  const [balance, setBalance] = useState("");

  async function add() {
    if (!title.trim() || !balance.trim()) return;
    await addAccount({
      type,
      title: title.trim(),
      currency_code: currency,
      balance: Math.round(Number(balance.replace(",", ".")) * 100),
    }).unwrap();
    setTitle("");
    setBalance("");
    setOpen(false);
  }

  return (
    <section style={{ marginTop: 8 }}>
      <div className="section-head">
        <h2>Додати вручну</h2>
        <button className="btn ghost label" onClick={() => setOpen((o) => !o)}>{open ? "згорнути" : "＋ рахунок"}</button>
      </div>
      {open && (
        <div className="card" style={{ padding: 16 }}>
          <div className="acct-add-grid">
            <select value={type} onChange={(e) => setType(e.target.value as "manual_card" | "crypto")}>
              <option value="crypto">Крипта / USDT</option>
              <option value="manual_card">Картка / рахунок</option>
            </select>
            <input placeholder="Назва (напр. «USDT» чи «Revolut»)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <select value={currency} onChange={(e) => setCurrency(Number(e.target.value))}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            <input type="number" inputMode="decimal" placeholder="Баланс" value={balance} onChange={(e) => setBalance(e.target.value)} />
            <button className="btn primary" onClick={add} disabled={isLoading || !title.trim() || !balance.trim()}>Додати</button>
          </div>
          <div className="sub" style={{ marginTop: 10, fontSize: 12.5 }}>
            Крипта/USDT конвертується в ₴ за курсом $ у підсумку та runway.
          </div>
        </div>
      )}
    </section>
  );
}
