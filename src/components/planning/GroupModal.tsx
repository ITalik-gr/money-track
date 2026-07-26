import { useEffect, useState } from "react";
import { useCreateEventMutation } from "../../store/api.ts";
import { useT, type TranslationKey } from "../../i18n/index.ts";
import { Select } from "../ui/Select.tsx";

// Типи груп + типовий колір. Група = будь-що: подорож, проєкт, ремонт, місяць.
export const GROUP_KINDS: { value: string; labelKey: TranslationKey; color: string }[] = [
  { value: "trip", labelKey: "grp.kindTrip", color: "#127c86" },
  { value: "project", labelKey: "grp.kindProject", color: "#7a3e9d" },
  { value: "event", labelKey: "grp.kindEvent", color: "#2e6be6" },
  { value: "day", labelKey: "grp.kindDay", color: "#c9871a" },
];

const PALETTE = ["#2e6be6", "#127c86", "#7a3e9d", "#c9871a", "#b23a2e", "#1f6e4c", "#c2417a", "#5a6b7a"];

// Попап швидкого й гарного створення групи: назва + тип + колір + опис для AI.
// Головна ідея груп — дати AI контекст, тому опис на видноті.
export function GroupModal({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: number) => void }) {
  const t = useT();
  const [createEvent, { isLoading }] = useCreateEventMutation();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("trip");
  const [color, setColor] = useState(PALETTE[0]);
  const [note, setNote] = useState("");

  // Колір за замовчуванням підтягуємо під тип, поки користувач не обрав вручну.
  const [colorTouched, setColorTouched] = useState(false);
  useEffect(() => {
    if (!colorTouched) setColor(GROUP_KINDS.find((k) => k.value === kind)?.color ?? PALETTE[0]);
  }, [kind, colorTouched]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  async function create() {
    if (!name.trim()) return;
    const r = await createEvent({ name: name.trim(), kind, color, note: note.trim() || undefined }).unwrap();
    onCreated?.(r.id);
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t("grp.newTitle")}</h3>
          <button className="modal-x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("catModal.nameLabel")}</span>
            <input autoFocus placeholder={t("grp.namePlaceholder")}
              value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} />
          </label>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("catModal.typeLabel")}</span>
            <Select value={kind} onChange={(v) => setKind(String(v))}
              options={GROUP_KINDS.map((k) => ({ value: k.value, label: t(k.labelKey), color: k.color }))} />
          </label>

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">{t("catModal.colorLabel")}</span>
            <div className="color-row">
              {PALETTE.map((c) => (
                <button key={c} type="button" className={`swatch ${color === c ? "on" : ""}`}
                  style={{ background: c }} onClick={() => { setColor(c); setColorTouched(true); }} aria-label={c} />
              ))}
            </div>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">{t("grp.aiDescLabel")}</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={t("grp.aiDescPlaceholder")} />
          </label>

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={create} disabled={isLoading || !name.trim()}>{t("goalModal.createBtn")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
