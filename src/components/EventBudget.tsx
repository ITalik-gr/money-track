// Бюджет події/подорожі: смуга прогресу + інлайн-редактор ліміту.
// Свідомо повторює мову конвертів (`ok`/`warn`/`over`, заливка scaleX) — це той самий
// патерн «ліміт і скільки з нього з'їдено», і вигадувати для нього другий вигляд не можна.
import { useState } from "react";
import { useSetEventBudgetMutation } from "../store/api.ts";
import { Money } from "./Money.tsx";
import { Icon } from "./Icon.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";

function state(ratio: number): "ok" | "warn" | "over" {
  if (ratio >= 1) return "over";
  if (ratio >= 0.85) return "warn";
  return "ok";
}

/** Тонка смуга під карткою події у списку. */
export function EventBudgetBar({ spent, budget }: { spent: number; budget: number }) {
  const ratio = budget > 0 ? spent / budget : 0;
  return (
    <div className={`eb-bar ${state(ratio)}`} aria-hidden="true">
      <span className="eb-fill" style={{ transform: `scaleX(${Math.min(1, Math.max(0, ratio))})` }} />
    </div>
  );
}

/** Блок на сторінці події: стан + редагування ліміту. */
export function EventBudget({ id, spent, budget }: { id: number; spent: number; budget: number | null }) {
  const [save, { isLoading }] = useSetEventBudgetMutation();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(budget ? String(Math.round(budget / 100)) : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const major = Number(val.replace(",", "."));
    if (val.trim() && (!Number.isFinite(major) || major < 0)) { toast.error("Сума має бути числом"); return; }
    try {
      await save({ id, budget: val.trim() ? Math.round(major * 100) : null }).unwrap();
      setEditing(false);
    } catch (err) { toast.error(errText(err)); }
  }

  if (editing || budget == null) {
    return (
      <form className="card eb-edit" onSubmit={submit}>
        <div className="label">Бюджет на цю подію</div>
        <div className="eb-edit-row">
          <input
            autoFocus={editing} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)}
            placeholder="напр. 25000" aria-label="Бюджет у гривнях"
            onKeyDown={(e) => { if (e.key === "Escape" && budget != null) { setEditing(false); setVal(String(Math.round(budget / 100))); } }}
          />
          <span className="eb-cur">₴</span>
          <button className="btn primary sm" disabled={isLoading}>Зберегти</button>
          {budget != null && (
            <button type="button" className="btn ghost sm" onClick={() => { setEditing(false); setVal(String(Math.round(budget / 100))); }}>
              Скасувати
            </button>
          )}
        </div>
        <p className="eb-hint">
          Порожнє поле прибирає ліміт. Витрати групи зведено в ₴ за поточним курсом.
        </p>
      </form>
    );
  }

  const ratio = budget > 0 ? spent / budget : 0;
  const st = state(ratio);
  const left = budget - spent;

  return (
    <div className={`card eb ${st}`}>
      <div className="eb-head">
        <div>
          <div className="label">Бюджет події</div>
          <div className="eb-nums">
            <b><Money minor={spent} decimals={false} /></b>
            <span className="muted"> з <Money minor={budget} decimals={false} /></span>
          </div>
        </div>
        <button className="btn ghost sm" onClick={() => setEditing(true)}>
          <Icon name="edit" size={14} />Змінити
        </button>
      </div>

      <div className={`eb-bar ${st}`}>
        <span className="eb-fill" style={{ transform: `scaleX(${Math.min(1, Math.max(0, ratio))})` }} />
      </div>

      <div className="eb-foot">
        <span>{Math.round(ratio * 100)}% використано</span>
        {/* Перевитрату називаємо прямо, а не «залишок −500 ₴»: мінусовий залишок читається
            гірше, ніж явне «перевищено на». */}
        <span className={st === "over" ? "neg" : ""}>
          {left >= 0 ? <>лишилось <Money minor={left} decimals={false} /></> : <>перевищено на <Money minor={-left} decimals={false} /></>}
        </span>
      </div>
    </div>
  );
}
