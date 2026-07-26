import { useMemo, useState } from "react";
import { getLocale, localeTag } from "../../i18n/locale.ts";
import { useT, translate } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { Select } from "../ui/Select.tsx";
import { formatMinor } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";
import {
  useGetFactsQuery, useAddFactMutation, useConfirmFactMutation, useDeleteFactMutation,
  useGetCategoriesQuery, type Fact,
} from "../../store/api.ts";

// §A1 (AI 4.0): шар фактів про світ. Користувач пише факт («метро подорожчало 8→30 ₴»),
// система його пам'ятає, пояснює й — ЯКЩО підтверджено — рахує з ним (burn/runway).
// ⚠️ Гейт підтвердження: факт із коригуванням суми НЕ рухає числа, поки не «Застосувати».
const iso = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);
const dayStr = (u: number) => new Date(u * 1000).toLocaleDateString(localeTag(getLocale()), { day: "numeric", month: "short", year: "numeric" });

function effectLabel(f: Fact): string | null {
  if (f.adjust_kind === "multiplier" && f.adjust_value != null) return `×${f.adjust_value}`;
  if (f.adjust_kind === "delta_minor" && f.adjust_value != null) {
    const sign = f.adjust_value >= 0 ? "+" : "−";
    return translate(getLocale(), "facts.perMonth", { value: `${sign}${formatMinor(Math.abs(f.adjust_value))}` });
  }
  return null;
}

export function FactsCard() {
  const t = useT();
  const { data: facts } = useGetFactsQuery();
  const [adding, setAdding] = useState(false);
  const list = facts ?? [];

  return (
    <div className="card facts-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="info" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            {t("facts.title")}
            <InfoTip>{t("facts.tip")}</InfoTip>
          </div>
          <div className="label">{t("facts.subtitle")}</div>
        </div>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setAdding((v) => !v)}>
          <Icon name={adding ? "check" : "plus"} /> {adding ? t("facts.collapse") : t("facts.addBtn")}
        </button>
      </div>

      {adding && <FactForm onDone={() => setAdding(false)} />}

      {list.length === 0 && !adding && (
        <p className="muted" style={{ margin: 0 }}>{t("facts.emptyHint")}</p>
      )}

      {list.length > 0 && (
        <div className="facts-list">
          {list.map((f) => <FactRow key={f.id} f={f} />)}
        </div>
      )}
    </div>
  );
}

function FactRow({ f }: { f: Fact }) {
  const t = useT();
  const [confirmFact, { isLoading: confirming }] = useConfirmFactMutation();
  const [deleteFact] = useDeleteFactMutation();
  const eff = effectLabel(f);
  const applied = f.confirmed_at != null && f.adjust_kind != null;
  const proposable = f.adjust_kind != null; // має коригування числа → потрібен гейт

  return (
    <div className="fact-item">
      <div className="fact-item-main">
        <div className="fact-item-text">{f.text}</div>
        <div className="fact-item-meta">
          <span className="muted">{t("facts.since", { date: dayStr(f.effective_from) })}{f.expires_at ? t("facts.until", { date: dayStr(f.expires_at) }) : ""}</span>
          {f.category_name && <span className="fact-chip">{f.category_name}</span>}
          {eff && <span className={`fact-chip ${applied ? "on" : ""}`}>{eff}</span>}
          {proposable && (
            <span className={`fact-status ${applied ? "on" : ""}`}>
              {applied ? t("facts.appliedStatus") : t("facts.notAppliedStatus")}
            </span>
          )}
        </div>
      </div>
      <div className="fact-item-actions">
        {proposable && (
          <button
            className={`btn sm ${applied ? "ghost" : "primary"}`}
            disabled={confirming}
            onClick={() => confirmFact({ id: f.id, on: !applied })}
            title={applied ? t("facts.removeFromCalcTitle") : t("facts.applyToBurnTitle")}
          >
            {applied ? t("facts.undoBtn") : t("facts.applyBtn")}
          </button>
        )}
        <button className="btn sm icon ghost" title={t("common.delete")} onClick={() => deleteFact(f.id)}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function FactForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { data: cats } = useGetCategoriesQuery();
  const [addFact, { isLoading }] = useAddFactMutation();
  const [text, setText] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [kind, setKind] = useState<"none" | "multiplier" | "delta_minor">("none");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(iso(Math.floor(Date.now() / 1000)));

  const catOptions = useMemo(
    () => (cats ?? []).filter((c) => c.parent_id == null).map((c) => ({ value: c.id, label: c.name, color: c.color })),
    [cats],
  );

  const submit = async () => {
    if (!text.trim()) { toast.info(t("facts.toastNeedText")); return; }
    let adjust_kind: "multiplier" | "delta_minor" | null = null;
    let adjust_value: number | null = null;
    if (categoryId != null && kind !== "none") {
      const n = Number(amount.replace(",", "."));
      if (!Number.isFinite(n) || n === 0) { toast.info(t("facts.toastNeedNumber")); return; }
      if (kind === "multiplier") { adjust_kind = "multiplier"; adjust_value = n; }
      else { adjust_kind = "delta_minor"; adjust_value = Math.round(n * 100); } // ₴ → копійки
    }
    const fromUnix = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
    try {
      // Ручний факт: користувач сам ввів число → confirm=true (сам себе підтвердив).
      await addFact({ text: text.trim(), category_id: categoryId, effective_from: fromUnix, adjust_kind, adjust_value, confirm: true }).unwrap();
      toast.success(t("facts.toastAdded"));
      onDone();
    } catch {
      toast.error(t("facts.toastSaveFailed"));
    }
  };

  return (
    <div className="fact-form">
      <input className="fact-input" placeholder={t("facts.textPlaceholder")} value={text} onChange={(e) => setText(e.target.value)} />
      <label className="fact-field">
        <span className="fact-field-lbl">{t("facts.categoryLabel")}</span>
        <Select
          value={categoryId}
          options={catOptions}
          onChange={(v) => setCategoryId(v == null ? null : Number(v))}
          placeholder={t("facts.globalPlaceholder")}
          searchable
          clearable
          clearLabel={t("facts.globalPlaceholder")}
        />
      </label>
      <label className="fact-field">
        <span className="fact-field-lbl">{t("facts.effectiveFromLabel")}</span>
        <input type="date" className="fact-input fact-date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      {categoryId != null && (
        <label className="fact-field">
          <span className="fact-field-lbl">{t("facts.impactLabel")}</span>
          <Select
            value={kind}
            options={[
              { value: "none", label: t("facts.impactNone") },
              { value: "multiplier", label: t("facts.impactMultiplier") },
              { value: "delta_minor", label: t("facts.impactDelta") },
            ]}
            onChange={(v) => setKind(v as "none" | "multiplier" | "delta_minor")}
          />
          {kind !== "none" && (
            <input
              className="fact-input"
              inputMode="decimal"
              placeholder={kind === "multiplier" ? t("facts.amountPlaceholderMultiplier") : t("facts.amountPlaceholderDelta")}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </label>
      )}
      <div className="fact-form-actions">
        <button className="btn sm ghost" onClick={onDone}>{t("common.cancel")}</button>
        <button className="btn sm primary" disabled={isLoading} onClick={submit}>{t("common.save")}</button>
      </div>
    </div>
  );
}
