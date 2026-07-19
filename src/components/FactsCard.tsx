import { useMemo, useState } from "react";
import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { Select } from "./Select.tsx";
import { formatMinor } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";
import {
  useGetFactsQuery, useAddFactMutation, useConfirmFactMutation, useDeleteFactMutation,
  useGetCategoriesQuery, type Fact,
} from "../store/api.ts";

// §A1 (AI 4.0): шар фактів про світ. Користувач пише факт («метро подорожчало 8→30 ₴»),
// система його пам'ятає, пояснює й — ЯКЩО підтверджено — рахує з ним (burn/runway).
// ⚠️ Гейт підтвердження: факт із коригуванням суми НЕ рухає числа, поки не «Застосувати».
const iso = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);
const dayStr = (u: number) => new Date(u * 1000).toLocaleDateString("uk-UA", { day: "numeric", month: "short", year: "numeric" });

function effectLabel(f: Fact): string | null {
  if (f.adjust_kind === "multiplier" && f.adjust_value != null) return `×${f.adjust_value}`;
  if (f.adjust_kind === "delta_minor" && f.adjust_value != null) {
    const sign = f.adjust_value >= 0 ? "+" : "−";
    return `${sign}${formatMinor(Math.abs(f.adjust_value))} ₴/міс`;
  }
  return null;
}

export function FactsCard() {
  const { data: facts } = useGetFactsQuery();
  const [adding, setAdding] = useState(false);
  const list = facts ?? [];

  return (
    <div className="card facts-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="info" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            Факти
            <InfoTip>Факти про світ, які ти повідомляєш системі («метро подорожчало 8→30 ₴», «я звільнився»). AI враховує їх у поясненнях. Факт із коригуванням суми починає рухати burn/runway лише після «Застосувати».</InfoTip>
          </div>
          <div className="label">що ти повідомив системі</div>
        </div>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setAdding((v) => !v)}>
          <Icon name={adding ? "check" : "plus"} /> {adding ? "Згорнути" : "Додати"}
        </button>
      </div>

      {adding && <FactForm onDone={() => setAdding(false)} />}

      {list.length === 0 && !adding && (
        <p className="muted" style={{ margin: 0 }}>Ще нема фактів. Додай сам або попроси в чаті («запам'ятай, що…»).</p>
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
          <span className="muted">з {dayStr(f.effective_from)}{f.expires_at ? ` до ${dayStr(f.expires_at)}` : ""}</span>
          {f.category_name && <span className="fact-chip">{f.category_name}</span>}
          {eff && <span className={`fact-chip ${applied ? "on" : ""}`}>{eff}</span>}
          {proposable && (
            <span className={`fact-status ${applied ? "on" : ""}`}>
              {applied ? "враховано в числах" : "не застосовано"}
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
            title={applied ? "Прибрати з розрахунків (лишиться пояснювальним)" : "Застосувати до burn/runway"}
          >
            {applied ? "Скасувати" : "Застосувати"}
          </button>
        )}
        <button className="btn sm icon ghost" title="Видалити" onClick={() => deleteFact(f.id)}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function FactForm({ onDone }: { onDone: () => void }) {
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
    if (!text.trim()) { toast.info("Впиши текст факту"); return; }
    let adjust_kind: "multiplier" | "delta_minor" | null = null;
    let adjust_value: number | null = null;
    if (categoryId != null && kind !== "none") {
      const n = Number(amount.replace(",", "."));
      if (!Number.isFinite(n) || n === 0) { toast.info("Впиши число ефекту"); return; }
      if (kind === "multiplier") { adjust_kind = "multiplier"; adjust_value = n; }
      else { adjust_kind = "delta_minor"; adjust_value = Math.round(n * 100); } // ₴ → копійки
    }
    const fromUnix = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
    try {
      // Ручний факт: користувач сам ввів число → confirm=true (сам себе підтвердив).
      await addFact({ text: text.trim(), category_id: categoryId, effective_from: fromUnix, adjust_kind, adjust_value, confirm: true }).unwrap();
      toast.success("Факт додано");
      onDone();
    } catch {
      toast.error("Не вдалося зберегти факт");
    }
  };

  return (
    <div className="fact-form">
      <input className="fact-input" placeholder="Напр. Метро подорожчало 8 → 30 ₴" value={text} onChange={(e) => setText(e.target.value)} />
      <label className="fact-field">
        <span className="fact-field-lbl">Категорія (для впливу на суму)</span>
        <Select
          value={categoryId}
          options={catOptions}
          onChange={(v) => setCategoryId(v == null ? null : Number(v))}
          placeholder="— глобальний факт"
          searchable
          clearable
          clearLabel="— глобальний факт"
        />
      </label>
      <label className="fact-field">
        <span className="fact-field-lbl">Діє з</span>
        <input type="date" className="fact-input fact-date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      {categoryId != null && (
        <label className="fact-field">
          <span className="fact-field-lbl">Вплив на місячну суму</span>
          <Select
            value={kind}
            options={[
              { value: "none", label: "Без впливу на суму" },
              { value: "multiplier", label: "×N разів (напр. ×3.75)" },
              { value: "delta_minor", label: "±N ₴/міс" },
            ]}
            onChange={(v) => setKind(v as "none" | "multiplier" | "delta_minor")}
          />
          {kind !== "none" && (
            <input
              className="fact-input"
              inputMode="decimal"
              placeholder={kind === "multiplier" ? "напр. 3.75" : "напр. +200 або −150"}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </label>
      )}
      <div className="fact-form-actions">
        <button className="btn sm ghost" onClick={onDone}>Скасувати</button>
        <button className="btn sm primary" disabled={isLoading} onClick={submit}>Зберегти</button>
      </div>
    </div>
  );
}
