/**
 * §SUB-SETTINGS — a subscription's own controls, on its own page.
 *
 * Until now the plan page could only be read: the amount, the period, the category and the note
 * were edited on the list page's card (category and note only), and the amount could not be edited
 * anywhere at all — deleting and re-creating the plan was the only way to change a price by hand.
 *
 * ⚠️ Saved by an explicit button, never on blur. ⚠️ The amount is in the PLAN's currency (§CUR-PLAN)
 * and is labelled with it. ⚠️ The note is where a plan's OTHER NAMES live (§SUB-ALIAS — «X Corp.» is
 * the owner's Twitter), so the field says so: it changes what the plan matches, not just a comment.
 * ⚠️ «End» is two clicks — a soft end (`is_active = 0`), history stays linked (§E1).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { useGetCategoriesQuery, useUpdatePlannedMutation, useDeletePlannedMutation } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { currencySign } from "../../../shared/currency.ts";
import { Select } from "../ui/Select.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import type { SubscriptionOverview } from "../../../shared/api/planning.ts";

export function SubSettings({ plan }: { plan: SubscriptionOverview["plan"] }) {
  const t = useT();
  const navigate = useNavigate();
  const { data: cats } = useGetCategoriesQuery();
  const [update, { isLoading: saving }] = useUpdatePlannedMutation();
  const [end] = useDeletePlannedMutation();

  const [amount, setAmount] = useState(plan.period_amount != null ? String(plan.period_amount / 100) : "");
  const [period, setPeriod] = useState<"month" | "week">(plan.period === "week" ? "week" : "month");
  const [count, setCount] = useState(String(plan.period_count ?? 1));
  const [note, setNote] = useState(plan.note ?? "");
  const [confirmEnd, setConfirmEnd] = useState(false);

  const catOptions = useMemo(() => {
    const out: { value: number; label: string; color?: string | null; icon?: string | null; indent?: boolean }[] = [];
    const list = (cats ?? []).filter((c) => !c.is_income);
    for (const p of list.filter((c) => c.parent_id == null)) {
      out.push({ value: p.id, label: p.name, color: p.color, icon: p.icon });
      for (const ch of list.filter((c) => c.parent_id === p.id)) out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
    }
    return out;
  }, [cats]);

  const minor = Math.round(Number(amount.replace(/\s/g, "").replace(",", ".")) * 100);
  const n = Math.round(Number(count));
  const scheduleDirty = minor !== plan.period_amount || period !== plan.period || n !== (plan.period_count ?? 1);
  const scheduleValid = Number.isFinite(minor) && minor > 0 && Number.isInteger(n) && n >= 1 && n <= 24;

  async function saveSchedule() {
    if (!scheduleValid) { toast.error(t("subset.bad")); return; }
    try {
      const r = await update({ id: plan.id, period_amount: minor, period, period_count: n }).unwrap();
      toast.success(r.linked > 0 ? t("subset.savedLinked", { n: r.linked }) : t("subset.saved"));
    } catch (e) { toast.error(errText(e)); }
  }

  async function saveNote() {
    try {
      const r = await update({ id: plan.id, note: note.trim() || null }).unwrap();
      toast.success(r.linked > 0 ? t("subset.savedLinked", { n: r.linked }) : t("subset.saved"));
    } catch (e) { toast.error(errText(e)); }
  }

  async function endPlan() {
    try {
      await end(plan.id).unwrap();
      toast.success(t("subset.ended"));
      navigate("/subs");
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="card sub-settings">
      <div className="label">{t("subset.title")}</div>

      <div className="ss-row">
        <span className="ss-lbl">{t("subset.amount")}</span>
        <div className="ss-ctrl">
          <input className="ss-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={t("subset.amount")} />
          <span className="ss-cur">{currencySign(plan.currency_code)}</span>
          <span className="ss-sep">{t("subset.every")}</span>
          <input className="ss-count" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} aria-label={t("subset.every")} />
          <div className="seg" role="radiogroup" aria-label={t("subset.period")}>
            {(["month", "week"] as const).map((p) => (
              <button key={p} role="radio" aria-checked={period === p} className={`seg-btn ${period === p ? "active" : ""}`} onClick={() => setPeriod(p)}>
                {t(p === "month" ? "subset.months" : "subset.weeks")}
              </button>
            ))}
          </div>
          <button className="btn sm" disabled={saving || !scheduleDirty} onClick={saveSchedule}>{t("catset.save")}</button>
        </div>
      </div>

      <div className="ss-row">
        <span className="ss-lbl">{t("sub.category")}</span>
        <div className="ss-ctrl ss-cat">
          <Select
            value={plan.category_id} options={catOptions} searchable clearable clearLabel={t("sub.noCategory")}
            placeholder={t("sub.pickCategory")}
            onChange={(v) => update({ id: plan.id, category_id: v == null ? null : Number(v) }).unwrap().catch((e) => toast.error(errText(e)))}
          />
        </div>
      </div>

      <div className="ss-row ss-note-row">
        <span className="ss-lbl">
          {t("subset.names")}
          <InfoTip>{t("subset.namesTip")}</InfoTip>
        </span>
        <div className="ss-ctrl ss-note">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("subset.namesPlaceholder")} aria-label={t("subset.names")} />
          <button className="btn sm" disabled={saving || note === (plan.note ?? "")} onClick={saveNote}>{t("catset.save")}</button>
        </div>
      </div>

      {plan.is_active && (
        <div className="ss-end">
          {confirmEnd ? (
            <>
              <span className="ss-end-q">{t("subset.endConfirm")}</span>
              <button className="btn sm danger" onClick={endPlan}>{t("subset.endYes")}</button>
              <button className="btn ghost sm" onClick={() => setConfirmEnd(false)}>{t("common.cancel")}</button>
            </>
          ) : (
            <button className="btn ghost sm" onClick={() => setConfirmEnd(true)}>{t("subset.end")}</button>
          )}
        </div>
      )}
    </div>
  );
}
