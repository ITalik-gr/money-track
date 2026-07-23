import { useEffect, useState } from "react";
import { useAddManualAccountMutation } from "../store/api.ts";
import { Select } from "./Select.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";

const CURRENCIES = [
  { value: 980, label: "₴ UAH" },
  { value: 840, label: "$ USD" },
  { value: 978, label: "€ EUR" },
];

// Базові «категорії» рахунку — пресети, що виставляють тип/роль/валюту/кредит. Користувач далі
// може змінити валюту й роль вручну. Тип у БД лишається з набору manual_card|crypto|cash|jar.
type Kind = { id: string; label: string; hint: string; type: string; role: "liquid" | "investment"; currency: number; credit?: boolean };
const KINDS: Kind[] = [
  { id: "debit", label: "Дебетова", hint: "звичайна картка/рахунок", type: "manual_card", role: "liquid", currency: 980 },
  { id: "credit", label: "Кредитна", hint: "картка з лімітом і боргом", type: "manual_card", role: "liquid", currency: 980, credit: true },
  { id: "fx", label: "Валютна", hint: "рахунок в $/€", type: "manual_card", role: "liquid", currency: 840 },
  { id: "cash", label: "Готівка", hint: "гроші на руках", type: "cash", role: "liquid", currency: 980 },
  { id: "crypto", label: "Крипта", hint: "USDT/BTC — інвест-резерв", type: "crypto", role: "investment", currency: 840 },
  { id: "invest", label: "Інвестиції", hint: "брокер/акції — не подушка", type: "manual_card", role: "investment", currency: 840 },
  { id: "jar", label: "Банка", hint: "накопичення під ціль", type: "jar", role: "liquid", currency: 980 },
];

const ROLE_OPTIONS = [
  { value: "liquid", label: "Ліквідний (у подушку)" },
  { value: "investment", label: "Інвестиційний (не подушка)" },
];

export function AddAccountModal({ onClose }: { onClose: () => void }) {
  const [addAccount, { isLoading }] = useAddManualAccountMutation();
  const [kindId, setKindId] = useState("debit");
  const kind = KINDS.find((k) => k.id === kindId)!;
  const [title, setTitle] = useState("");
  const [currency, setCurrency] = useState(kind.currency);
  const [role, setRole] = useState<"liquid" | "investment">(kind.role);
  const [balance, setBalance] = useState("");
  const [limit, setLimit] = useState("");   // кредитна: ліміт
  const [used, setUsed] = useState("");      // кредитна: використано (борг)
  const [note, setNote] = useState("");

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Зміна пресету підставляє його валюту/роль (але не перетирає, якщо юзер уже щось увів).
  function pickKind(id: string) {
    const k = KINDS.find((x) => x.id === id)!;
    setKindId(id);
    setCurrency(k.currency);
    setRole(k.role);
  }

  const minor = (s: string) => Math.round(Number(s.replace(",", ".") || 0) * 100);
  const valid = title.trim() && (kind.credit ? limit.trim() : balance.trim());

  async function save() {
    if (!valid) return;
    // Кредитна: власний баланс = ліміт − борг (own = balance − limit = −борг), як у mono-картки.
    const creditLimit = kind.credit ? minor(limit) : 0;
    const bal = kind.credit ? creditLimit - minor(used) : minor(balance);
    try {
      await addAccount({
        type: kind.type, title: title.trim(), currency_code: currency, balance: bal,
        role, credit_limit: creditLimit || undefined, ai_note: note.trim() || undefined,
      }).unwrap();
      toast.success("Рахунок додано");
      onClose();
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Новий рахунок</h3>
          <button className="modal-x" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">тип рахунку</span>
            <div className="kind-grid">
              {KINDS.map((k) => (
                <button key={k.id} type="button" className={`kind-btn ${kindId === k.id ? "on" : ""}`} onClick={() => pickKind(k.id)}>
                  <span className="kb-label">{k.label}</span>
                  <span className="kb-hint">{k.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">назва</span>
            <input autoFocus placeholder="напр. «USDT», «Revolut», «Кредитка ПУМБ»" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <div className="row" style={{ gap: 10 }}>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">валюта</span>
              <Select value={currency} options={CURRENCIES} onChange={(v) => setCurrency(Number(v))} />
            </label>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">роль</span>
              <Select value={role} options={ROLE_OPTIONS} onChange={(v) => setRole(v as "liquid" | "investment")} />
            </label>
          </div>

          {kind.credit ? (
            <div className="row" style={{ gap: 10 }}>
              <label className="stack" style={{ gap: 5, flex: 1 }}>
                <span className="label">кредитний ліміт</span>
                <input type="number" inputMode="decimal" placeholder="0" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </label>
              <label className="stack" style={{ gap: 5, flex: 1 }}>
                <span className="label">використано (борг)</span>
                <input type="number" inputMode="decimal" placeholder="0" value={used} onChange={(e) => setUsed(e.target.value)} />
              </label>
            </div>
          ) : (
            <label className="stack" style={{ gap: 5 }}>
              <span className="label">поточний баланс</span>
              <input type="number" inputMode="decimal" placeholder="0" value={balance} onChange={(e) => setBalance(e.target.value)} />
            </label>
          )}

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">опис для AI (опц.)</span>
            <textarea className="acct-note-input" rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="напр. «USDT — інвестиції, чіпати лише в крайньому разі» або «зарплатна картка»" />
          </label>

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>Скасувати</button>
            <button className="btn primary" onClick={save} disabled={isLoading || !valid}>Додати</button>
          </div>
        </div>
      </div>
    </div>
  );
}
