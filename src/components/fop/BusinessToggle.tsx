import { useT } from "../../i18n/index.ts";
import { useSetTxBusinessMutation, useGetTaxStatusQuery } from "../../store/api.ts";
import { useFopVisible } from "./gate.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";

/**
 * §TAX-BASE — «is this a business operation?», on the operation itself.
 *
 * THREE states, not two, because the column is nullable and the third state is the useful one:
 *   inherit — nobody was asked; the ACCOUNT answers (a ФОП account makes its income business)
 *   yes/no  — a human decided, for this row, and the account no longer speaks for it
 *
 * A two-way switch would have to pick a default, and picking one would silently convert «not yet
 * asked» into «the user said no» for every row ever imported — which is the answer that quietly
 * removes income from the tax base.
 *
 * Renders nothing when the ФОП module is off: a toggle for a feature the user has not turned on
 * is a question about a life they may not lead.
 */
/**
 * docs/JEV.md phase 3 — when Jev's `ai_business` is OFFERED, measured on the eval (§7.3): every
 * work operation came back ≥ 0.88 and every personal one ≤ 0.56, so these two lines sit in the gap
 * with room on both sides. Offered, never applied: `is_business` moves a tax figure, and only the
 * person's click writes it.
 */
const PROPOSE_WORK_AT = 0.8;
const PROPOSE_PERSONAL_AT = 0.3;

export function BusinessToggle({ txId, value, proposal, accountBusiness }: {
  txId: string; value: number | null; proposal?: number | null; accountBusiness?: number | null;
}) {
  const t = useT();
  // §FOP-GATE — asked BEFORE the request, not after: a refused query would toast a 404 on a
  // screen that is meant to show nothing at all.
  const visible = useFopVisible();
  const { data: status } = useGetTaxStatusQuery(undefined, { skip: !visible });
  const [setBusiness, { isLoading }] = useSetTxBusinessMutation();
  if (!visible || !status?.enabled) return null;

  const set = async (business: 0 | 1 | null) => {
    try { await setBusiness({ id: txId, business }).unwrap(); }
    catch (e) { toast.error(errText(e)); }
  };

  const options: { v: 0 | 1 | null; label: string }[] = [
    { v: null, label: t("fop.tx.inherit") },
    { v: 1, label: t("fop.tx.yes") },
    { v: 0, label: t("fop.tx.no") },
  ];

  // Only where the answer would CHANGE something: a NULL row resolves to the account, so a proposal
  // that agrees with the account is noise — and a row a person already decided is not reopened.
  const suggest: 0 | 1 | null =
    value !== null || proposal == null ? null
    : !accountBusiness && proposal >= PROPOSE_WORK_AT ? 1
    : accountBusiness && proposal <= PROPOSE_PERSONAL_AT ? 0
    : null;

  return (
    <div className="fop-tx">
      <span className="fop-tx-label">{t("fop.tx.label")}</span>
      <div className="seg">
        {options.map((o) => (
          <button
            key={String(o.v)}
            className={`seg-btn ${value === o.v ? "active" : ""}`}
            disabled={isLoading}
            onClick={() => set(o.v)}
          >{o.label}</button>
        ))}
      </div>
      {suggest !== null && (
        <span className="fop-tx-suggest">
          {t(suggest === 1 ? "fop.tx.suggestWork" : "fop.tx.suggestPersonal")}
          <button className="btn ghost" disabled={isLoading} onClick={() => set(suggest)}>
            {t(suggest === 1 ? "fop.tx.acceptWork" : "fop.tx.acceptPersonal")}
          </button>
        </span>
      )}
      {/* Said where the decision is made, not only on /fop: somebody marking a purchase as a work
          expense will assume it lowers the tax. On the single tax it does not. */}
      <span className="fop-tx-note">{t("fop.tx.note")}</span>
    </div>
  );
}
