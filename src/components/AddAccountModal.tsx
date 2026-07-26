import { useEffect, useState } from "react";
import { useAddManualAccountMutation } from "../store/api.ts";
import { Select } from "./Select.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { useT, type TranslationKey } from "../i18n/index.ts";

const CURRENCIES = [
  { value: 980, label: "₴ UAH" },
  { value: 840, label: "$ USD" },
  { value: 978, label: "€ EUR" },
];

// Базові «категорії» рахунку — пресети, що виставляють тип/роль/валюту/кредит. Користувач далі
// може змінити валюту й роль вручну. Тип у БД лишається з набору manual_card|crypto|cash|jar.
type Kind = { id: string; labelKey: TranslationKey; hintKey: TranslationKey; type: string; role: "liquid" | "investment"; currency: number; credit?: boolean };
const KINDS: Kind[] = [
  { id: "debit", labelKey: "acctAdd.kindDebit", hintKey: "acctAdd.kindDebitHint", type: "manual_card", role: "liquid", currency: 980 },
  { id: "credit", labelKey: "acctAdd.kindCredit", hintKey: "acctAdd.kindCreditHint", type: "manual_card", role: "liquid", currency: 980, credit: true },
  { id: "fx", labelKey: "acctAdd.kindFx", hintKey: "acctAdd.kindFxHint", type: "manual_card", role: "liquid", currency: 840 },
  { id: "cash", labelKey: "acctAdd.kindCash", hintKey: "acctAdd.kindCashHint", type: "cash", role: "liquid", currency: 980 },
  { id: "crypto", labelKey: "acctAdd.kindCrypto", hintKey: "acctAdd.kindCryptoHint", type: "crypto", role: "investment", currency: 840 },
  { id: "invest", labelKey: "acctAdd.kindInvest", hintKey: "acctAdd.kindInvestHint", type: "manual_card", role: "investment", currency: 840 },
  { id: "jar", labelKey: "acctAdd.kindJar", hintKey: "acctAdd.kindJarHint", type: "jar", role: "liquid", currency: 980 },
];

export function AddAccountModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const ROLE_OPTIONS = [
    { value: "liquid", label: t("acctAdd.roleLiquid") },
    { value: "investment", label: t("acctAdd.roleInvestment") },
  ];
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
      toast.success(t("acctAdd.toastAdded"));
      onClose();
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t("acctAdd.title")}</h3>
          <button className="modal-x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">{t("acctAdd.kindTypeLabel")}</span>
            <div className="kind-grid">
              {KINDS.map((k) => (
                <button key={k.id} type="button" className={`kind-btn ${kindId === k.id ? "on" : ""}`} onClick={() => pickKind(k.id)}>
                  <span className="kb-label">{t(k.labelKey)}</span>
                  <span className="kb-hint">{t(k.hintKey)}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("acctAdd.nameLabel")}</span>
            <input autoFocus placeholder={t("acctAdd.namePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <div className="row" style={{ gap: 10 }}>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("acctAdd.currencyLabel")}</span>
              <Select value={currency} options={CURRENCIES} onChange={(v) => setCurrency(Number(v))} />
            </label>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("acctAdd.roleLabel")}</span>
              <Select value={role} options={ROLE_OPTIONS} onChange={(v) => setRole(v as "liquid" | "investment")} />
            </label>
          </div>

          {kind.credit ? (
            <div className="row" style={{ gap: 10 }}>
              <label className="stack" style={{ gap: 5, flex: 1 }}>
                <span className="label">{t("acctAdd.creditLimitLabel")}</span>
                <input type="number" inputMode="decimal" placeholder="0" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </label>
              <label className="stack" style={{ gap: 5, flex: 1 }}>
                <span className="label">{t("acctAdd.usedLabel")}</span>
                <input type="number" inputMode="decimal" placeholder="0" value={used} onChange={(e) => setUsed(e.target.value)} />
              </label>
            </div>
          ) : (
            <label className="stack" style={{ gap: 5 }}>
              <span className="label">{t("acctAdd.balanceLabel")}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={balance} onChange={(e) => setBalance(e.target.value)} />
            </label>
          )}

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("acctAdd.noteLabel")}</span>
            <textarea className="acct-note-input" rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={t("acctAdd.notePlaceholder")} />
          </label>

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={save} disabled={isLoading || !valid}>{t("acctAdd.saveBtn")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
