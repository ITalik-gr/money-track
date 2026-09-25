/**
 * §CAT-SETTINGS — the controls that belong to a category, on the category's own page.
 *
 * The owner: «налаштування мо якісь прям там». The page answered every question about a category
 * and let you change nothing: to set its envelope you went to Plan, to change its importance you
 * went to Categories, and to rename it you went there again. Editing a thing should not mean going
 * to look for it.
 *
 * ⚠️ Every control writes on an explicit action — a segment click, a Save — never on blur: a limit
 * saved because focus wandered is a budget the person did not set.
 * ⚠️ The envelope exists only for a top-level EXPENSE category (budgets live there, §BUDGET-*), and
 * only in the month view — `budgetStatus` is month-to-date by definition, and a limit edited beside
 * a year-long window would sit next to numbers about a different period.
 * ⚠️ The amount typed is in the reader's base; the server converts it (`baseToUah`, §BASE-CUR).
 */
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import {
  useGetCategoriesQuery, useUpdateCategoryMutation, useSetBudgetMutation, useRemoveBudgetMutation,
} from "../../store/api.ts";
import { IMPORTANCE_LEVELS, IMPORTANCE_META } from "../../lib/importance.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { baseSign } from "../../lib/currency.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { CategoryModal } from "../planning/CategoryModal.tsx";
import type { CategoryOverview } from "../../../shared/api/analytics.ts";

export function CategorySettings({ data, monthView }: { data: CategoryOverview; monthView: boolean }) {
  const t = useT();
  const { data: cats } = useGetCategoriesQuery();
  const [updateCategory, { isLoading: savingImp }] = useUpdateCategoryMutation();
  const [setBudget, { isLoading: savingBudget }] = useSetBudgetMutation();
  const [removeBudget] = useRemoveBudgetMutation();
  const [editing, setEditing] = useState(false);
  const current = data.budget ? Math.round(data.budget.base_amount / 100) : null;
  const [limit, setLimit] = useState<string>(current != null ? String(current) : "");

  const category = cats?.find((c) => c.id === data.id) ?? null;
  const canBudget = !data.is_income && !data.is_sub && monthView;

  async function pickImportance(level: string) {
    if (level === data.importance) return;
    try { await updateCategory({ id: data.id, importance: level }).unwrap(); }
    catch (e) { toast.error(errText(e)); }
  }

  async function saveLimit() {
    const n = Number(limit.replace(/\s/g, "").replace(",", "."));
    // An empty field is «no envelope», never 0 — a zero limit is a PLAN (§BUDGET-ZERO) and has to be
    // typed as one.
    if (limit.trim() === "") return;
    if (!Number.isFinite(n) || n < 0) { toast.error(t("catset.badLimit")); return; }
    try {
      await setBudget({ category_id: data.id, period: "month", amount: Math.round(n * 100) }).unwrap();
      toast.success(t("catset.limitSaved"));
    } catch (e) { toast.error(errText(e)); }
  }

  async function dropLimit() {
    try {
      await removeBudget({ category_id: data.id, period: "month" }).unwrap();
      setLimit("");
      toast.success(t("catset.limitRemoved"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card cat-settings">
      <div className="cs-head">
        <div className="label">{t("catset.title")}</div>
        {category && (
          <button className="btn ghost sm" onClick={() => setEditing(true)}>{t("catset.edit")}</button>
        )}
      </div>

      {!data.is_income && (
        <div className="cs-row">
          <span className="cs-lbl">
            {t("catset.importance")}
            <InfoTip>{t("catset.importanceTip")}</InfoTip>
          </span>
          <div className="seg cs-seg" role="radiogroup" aria-label={t("catset.importance")}>
            {IMPORTANCE_LEVELS.map((lv) => (
              <button
                key={lv} role="radio" aria-checked={data.importance === lv} disabled={savingImp}
                className={`seg-btn ${data.importance === lv ? "active" : ""}`}
                onClick={() => pickImportance(lv)}
              >
                {t(IMPORTANCE_META[lv].shortKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {canBudget && (
        <div className="cs-row">
          <span className="cs-lbl">
            {t("catset.limit")}
            <InfoTip>{t("catset.limitTip")}</InfoTip>
          </span>
          <div className="cs-limit">
            <input
              className="cs-input" inputMode="decimal" value={limit} placeholder={t("catset.limitPlaceholder")}
              onChange={(e) => setLimit(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLimit(); }}
              aria-label={t("catset.limit")}
            />
            <span className="cs-cur">{baseSign()}</span>
            <button className="btn sm" disabled={savingBudget || limit.trim() === "" || limit === String(current ?? "")} onClick={saveLimit}>
              {t("catset.save")}
            </button>
            {current != null && (
              <button className="btn ghost sm" onClick={dropLimit}>{t("catset.remove")}</button>
            )}
          </div>
        </div>
      )}
      {!data.is_income && !data.is_sub && !monthView && (
        <div className="cs-note">{t("catset.limitMonthOnly")}</div>
      )}

      {editing && category && <CategoryModal category={category} onClose={() => setEditing(false)} />}
    </div>
  );
}
