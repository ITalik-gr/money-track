// Бюджет події/подорожі: смуга прогресу + інлайн-редактор ліміту.
// Свідомо повторює мову конвертів (`ok`/`warn`/`over`, заливка scaleX) — це той самий
// патерн «ліміт і скільки з нього з'їдено», і вигадувати для нього другий вигляд не можна.
import { useState } from "react";
import { useSetEventBudgetMutation } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { Icon } from "../ui/Icon.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

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
  const t = useT();
  const [save, { isLoading }] = useSetEventBudgetMutation();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(budget ? String(Math.round(budget / 100)) : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const major = Number(val.replace(",", "."));
    if (val.trim() && (!Number.isFinite(major) || major < 0)) { toast.error(t("eb.amountMustBeNumber")); return; }
    try {
      await save({ id, budget: val.trim() ? Math.round(major * 100) : null }).unwrap();
      setEditing(false);
    } catch (err) { toast.error(errText(err)); }
  }

  if (editing || budget == null) {
    return (
      <form className="card eb-edit" onSubmit={submit}>
        <div className="label">{t("eb.setBudgetLabel")}</div>
        <div className="eb-edit-row">
          <input
            autoFocus={editing} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)}
            placeholder={t("eb.amountPlaceholder")} aria-label={t("eb.amountAriaLabel")}
            onKeyDown={(e) => { if (e.key === "Escape" && budget != null) { setEditing(false); setVal(String(Math.round(budget / 100))); } }}
          />
          <span className="eb-cur">{baseSign()}</span>
          <button className="btn primary sm" disabled={isLoading}>{t("common.save")}</button>
          {budget != null && (
            <button type="button" className="btn ghost sm" onClick={() => { setEditing(false); setVal(String(Math.round(budget / 100))); }}>
              {t("common.cancel")}
            </button>
          )}
        </div>
        <p className="eb-hint">{t("eb.hint")}</p>
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
          <div className="label">{t("eb.eventBudgetLabel")}</div>
          <div className="eb-nums">
            <b><Money minor={spent} decimals={false} /></b>
            <span className="muted"> {t("goal.ofTarget")} <Money minor={budget} decimals={false} /></span>
          </div>
        </div>
        <button className="btn ghost sm" onClick={() => setEditing(true)}>
          <Icon name="edit" size={14} />{t("eb.editBtn")}
        </button>
      </div>

      <div className={`eb-bar ${st}`}>
        <span className="eb-fill" style={{ transform: `scaleX(${Math.min(1, Math.max(0, ratio))})` }} />
      </div>

      <div className="eb-foot">
        <span>{t("eb.usedPct", { pct: Math.round(ratio * 100) })}</span>
        {/* Перевитрату називаємо прямо, а не «залишок −500 ₴»: мінусовий залишок читається
            гірше, ніж явне «перевищено на». */}
        <span className={st === "over" ? "neg" : ""}>
          {left >= 0 ? <>{t("goal.leftPrefix")} <Money minor={left} decimals={false} /></> : <>{t("eb.overBy")} <Money minor={-left} decimals={false} /></>}
        </span>
      </div>
    </div>
  );
}
