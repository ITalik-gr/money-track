// Збережені фільтри Транзакцій («Робочі витрати», «Готівка», «Цього тижня»).
// Фільтри вже живуть в URL, тож зберігати треба рівно один рядок — той самий query.
// Завдяки цьому нове поле фільтра почне зберігатись саме, без правок тут.
import { useState } from "react";
import {
  useGetSavedFiltersQuery, useSaveFilterMutation, useDeleteSavedFilterMutation,
} from "../store/api.ts";
import { Icon } from "./Icon.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";

interface Props {
  /** Поточний query-рядок сторінки (`params.toString()`). */
  current: string;
  /** Застосувати збережений набір. */
  onApply: (query: string) => void;
}

// Технічні ключі стану сторінки, які не є фільтрами — їх не зберігаємо й не порівнюємо.
const IGNORED = new Set(["tab"]);
const cleanQuery = (q: string) => {
  const p = new URLSearchParams(q);
  for (const k of IGNORED) p.delete(k);
  p.sort(); // порядок ключів не має впливати на «це той самий фільтр»
  return p.toString();
};

export function SavedFilters({ current, onApply }: Props) {
  const { data: filters = [] } = useGetSavedFiltersQuery();
  const [save, { isLoading: saving }] = useSaveFilterMutation();
  const [remove] = useDeleteSavedFilterMutation();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const cur = cleanQuery(current);
  const activeId = filters.find((f) => cleanQuery(f.query) === cur)?.id ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await save({ name: name.trim(), query: cur }).unwrap();
      toast.success("Фільтр збережено");
      setNaming(false); setName("");
    } catch (err) { toast.error(errText(err)); }
  }

  async function del(id: string, label: string) {
    if (!confirm(`Видалити фільтр «${label}»?`)) return;
    try { await remove(id).unwrap(); }
    catch (err) { toast.error(errText(err)); }
  }

  // Ховаємо блок, поки нема ні збережених, ні активних фільтрів: порожній заголовок
  // «Збережені» у сайдбарі — це шум, який нічого не пропонує.
  if (!filters.length && !cur) return null;

  return (
    <div className="sf">
      <div className="sf-head">Збережені</div>

      {filters.length > 0 && (
        <div className="sf-list">
          {filters.map((f) => (
            <div key={f.id} className={`sf-item ${f.id === activeId ? "active" : ""}`}>
              <button type="button" className="sf-apply" onClick={() => onApply(f.query)} title={f.name}>
                {f.id === activeId && <Icon name="check" size={13} />}
                <span>{f.name}</span>
              </button>
              <button type="button" className="sf-del" onClick={() => del(f.id, f.name)} aria-label={`Видалити ${f.name}`}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Кнопка зʼявляється лише коли є що зберігати і це ще не збережено — інакше вона
          пропонувала б створити дубль того, що вже стоїть активним. */}
      {cur && !activeId && (
        naming ? (
          <form className="sf-form" onSubmit={submit}>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Назва фільтра" maxLength={60} aria-label="Назва фільтра"
              onKeyDown={(e) => { if (e.key === "Escape") { setNaming(false); setName(""); } }}
            />
            <button className="btn sm primary" disabled={saving || !name.trim()}>Ок</button>
          </form>
        ) : (
          <button type="button" className="btn ghost sm sf-add" onClick={() => setNaming(true)}>
            <Icon name="plus" size={14} />Зберегти цей набір
          </button>
        )
      )}
    </div>
  );
}
