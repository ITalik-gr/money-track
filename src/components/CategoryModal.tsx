import { useEffect, useState } from "react";
import {
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useGetCategoriesQuery,
} from "../store/api.ts";
import { CategoryIcon, ICON_SLUGS } from "./CategoryIcon.tsx";
import { Select } from "./Select.tsx";
import { IMPORTANCE_LEVELS, IMPORTANCE_META } from "../lib/importance.ts";
import { useT, translate } from "../i18n/index.ts";
import { getLocale } from "../i18n/locale.ts";
import type { Category } from "../../shared/types.ts";

const PALETTE = [
  "#2e6be6", "#127c86", "#1f6e4c", "#7a3e9d", "#c2417a", "#b23a2e",
  "#c9871a", "#12805c", "#0e7490", "#4f46e5", "#9333ea", "#5a6b7a",
];

function importanceHint(v: string | null): string {
  if (v == null) return translate(getLocale(), "catModal.defaultImportanceHint");
  return translate(getLocale(), IMPORTANCE_META[v as keyof typeof IMPORTANCE_META].hintKey);
}

// Створення / редагування категорії: назва + тип (дохід/витрата) + батько (для
// підкатегорій) + колір-свотчі + пікер іконки. Редагувати можна й вбудовані.
export function CategoryModal({ category, defaultParentId, defaultIncome, onClose }: {
  category?: Category | null; defaultParentId?: number | null; defaultIncome?: boolean; onClose: () => void;
}) {
  const t = useT();
  const editing = !!category;
  const { data: cats = [] } = useGetCategoriesQuery();
  const [createCategory, { isLoading: creating }] = useCreateCategoryMutation();
  const [updateCategory, { isLoading: updating }] = useUpdateCategoryMutation();

  const [name, setName] = useState(category?.name ?? "");
  const [isIncome, setIsIncome] = useState(category ? !!category.is_income : !!defaultIncome);
  const [parentId, setParentId] = useState<number | null>(category?.parent_id ?? defaultParentId ?? null);
  const [color, setColor] = useState(category?.color ?? PALETTE[0]);
  const [icon, setIcon] = useState(category?.icon ?? "dots");
  const [importance, setImportance] = useState<string | null>(category?.importance ?? null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Кандидати в батьки — верхньорівневі категорії того ж типу (крім самої себе).
  const parentOptions = cats
    .filter((c) => c.parent_id == null && c.id !== category?.id && !!c.is_income === isIncome)
    .map((c) => ({ value: c.id, label: c.name, color: c.color, icon: c.icon }));

  const busy = creating || updating;

  async function save() {
    if (!name.trim()) return;
    const imp = isIncome ? null : importance;
    if (editing && category) {
      await updateCategory({ id: category.id, name: name.trim(), color, icon, parent_id: parentId, importance: imp }).unwrap();
    } else {
      await createCategory({ name: name.trim(), color, icon, parent_id: parentId, is_income: isIncome, importance: imp }).unwrap();
    }
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{editing ? t("catModal.editTitle") : t("catModal.newTitle")}</h3>
          <button className="modal-x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
            <span className="cat-ico cat-preview" style={{ background: color }}><CategoryIcon slug={icon} size={22} /></span>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("catModal.nameLabel")}</span>
              <input autoFocus placeholder={t("catModal.namePlaceholder")} value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && name.trim() && save()} />
            </label>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("catModal.typeLabel")}</span>
              <Select value={isIncome ? "in" : "ex"} disabled={editing}
                onChange={(v) => { setIsIncome(v === "in"); setParentId(null); }}
                options={[{ value: "ex", label: t("catModal.typeExpense") }, { value: "in", label: t("catModal.typeIncome") }]} />
            </label>
            <label className="stack" style={{ gap: 5, flex: 1 }}>
              <span className="label">{t("catModal.parentLabel")}</span>
              <Select value={parentId} clearable clearLabel={t("catModal.topLevelClear")} searchable
                placeholder={t("catModal.topLevelClear")}
                onChange={(v) => setParentId(v == null ? null : Number(v))}
                options={parentOptions} />
            </label>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">{t("catModal.colorLabel")}</span>
            <div className="color-row">
              {PALETTE.map((cc) => (
                <button key={cc} type="button" className={`swatch ${color === cc ? "on" : ""}`}
                  style={{ background: cc }} onClick={() => setColor(cc)} aria-label={cc} />
              ))}
            </div>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">{t("catModal.iconLabel")}</span>
            <div className="icon-picker">
              {ICON_SLUGS.map((s) => (
                <button key={s} type="button" className={`icon-opt ${icon === s ? "on" : ""}`}
                  style={icon === s ? { background: color, color: "#fff", borderColor: color } : undefined}
                  onClick={() => setIcon(s)} aria-label={s}>
                  <CategoryIcon slug={s} size={18} />
                </button>
              ))}
            </div>
          </div>

          {!isIncome && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="label">{t("catModal.importanceLabel")}</span>
              <div className="imp-picker">
                {IMPORTANCE_LEVELS.map((lv) => {
                  const m = IMPORTANCE_META[lv];
                  const on = importance === lv;
                  return (
                    <button key={lv} type="button" title={t(m.hintKey)}
                      className={`imp-opt ${on ? "on" : ""}`}
                      style={on ? { borderColor: m.color, background: `color-mix(in srgb, ${m.color} 14%, transparent)`, color: m.color } : undefined}
                      onClick={() => setImportance(on ? null : lv)}>
                      <span className="d" style={{ background: m.color }} />{t(m.labelKey)}
                    </button>
                  );
                })}
              </div>
              <span className="ai-block-hint" style={{ margin: 0 }}>
                {importanceHint(importance)}
              </span>
            </div>
          )}

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>
              {editing ? t("common.save") : t("goalModal.createBtn")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
