import type { PlanState } from "../../../shared/api/planning.ts";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { useAcceptPlanPriceMutation } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Money } from "../ui/Money.tsx";

const fmtDay = dateFmt({ day: "numeric", month: "long" });

/** The states that are news. `paid`, `due`, `ended` and `no_history` say nothing here — the tiles do. */
export const planStateIsNews = (s: PlanState | undefined): boolean =>
  !!s && (s.kind === "changed" || s.kind === "late" || s.kind === "missing" || s.kind === "stopped");

/**
 * §PLAN-STATE on the subscription page — the sentence the card could not say before.
 *
 * The owner's YouTube went 100 → 179 ₴; the page kept promising next month's date while this
 * month's charge sat unlinked. Now the page says what happened, and offers the one action that fits:
 *   · `changed` — accept the new price. The amount is read by the SERVER from the latest linked
 *     charge (§PLAN-REPRICE); nothing here sends a number, and nothing changes without this click;
 *   · `late` / `missing` / `stopped` — look for the charge. «Not linked» is not «not paid»
 *     (§PLAN-LATE), and the commonest cause of a «late» plan is a row nothing attached — so the
 *     note asks rather than accuses, and offers the fix the page can do itself.
 */
export function PlanStateNote({ planId, state, declared, currency, onRelink, relinking }: {
  planId: number;
  state: PlanState;
  declared: number | null;
  currency: number;
  onRelink: () => void;
  relinking: boolean;
}) {
  const t = useT();
  const [accept, { isLoading: accepting }] = useAcceptPlanPriceMutation();
  if (!planStateIsNews(state)) return null;

  async function acceptPrice() {
    try {
      await accept(planId).unwrap();
      toast.success(t("planState.accepted"));
    } catch (e) { toast.error(errText(e)); }
  }

  if (state.kind === "changed" && state.paid_amount != null) {
    const pct = declared ? Math.round(((state.paid_amount - declared) / declared) * 100) : null;
    return (
      <div className="card plan-state warn" role="status">
        <div className="plan-state-text">
          <div className="plan-state-title">{t("planState.changedTitle")}</div>
          <div className="plan-state-sub">
            {declared != null && <><Money minor={declared} currency={currency} decimals={false} /> → </>}
            <Money minor={state.paid_amount} currency={currency} decimals={false} />
            {pct != null && <span className={pct > 0 ? "neg" : "pos"}> ({pct > 0 ? "+" : ""}{pct}%)</span>}
            {state.paid_at != null && <> · {t("planState.chargedOn", { date: fmtDay.format(new Date(state.paid_at * 1000)) })}</>}
          </div>
        </div>
        <button className="btn sm" disabled={accepting} onClick={acceptPrice}>{t("planState.accept")}</button>
      </div>
    );
  }

  const date = state.due_at != null ? fmtDay.format(new Date(state.due_at * 1000)) : "—";
  // Literal keys, not `${kind}Title`: a runtime-built key is invisible to the i18n parity check
  // (§I18N-DYNKEY), and there are only three.
  const keys = state.kind === "late" ? { title: "planState.lateTitle", body: "planState.late" } as const
    : state.kind === "missing" ? { title: "planState.missingTitle", body: "planState.missing" } as const
    : { title: "planState.stoppedTitle", body: "planState.stopped" } as const;
  return (
    <div className={`card plan-state ${state.kind === "late" ? "warn" : "bad"}`} role="status">
      <div className="plan-state-text">
        <div className="plan-state-title">{t(keys.title)}</div>
        <div className="plan-state-sub">
          {t(keys.body, { date, days: state.late_days ?? 0, n: state.missed_cycles })}
        </div>
      </div>
      <button className="btn ghost sm" disabled={relinking} onClick={onRelink}>{t("sub.relink")}</button>
    </div>
  );
}
