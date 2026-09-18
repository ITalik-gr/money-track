import { useT } from "../../i18n/index.ts";
import { useSetTxBusinessMutation, useGetTaxStatusQuery } from "../../store/api.ts";
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
export function BusinessToggle({ txId, value }: { txId: string; value: number | null }) {
  const t = useT();
  const { data: status } = useGetTaxStatusQuery();
  const [setBusiness, { isLoading }] = useSetTxBusinessMutation();
  if (!status?.enabled) return null;

  const set = async (business: 0 | 1 | null) => {
    try { await setBusiness({ id: txId, business }).unwrap(); }
    catch (e) { toast.error(errText(e)); }
  };

  const options: { v: 0 | 1 | null; label: string }[] = [
    { v: null, label: t("fop.tx.inherit") },
    { v: 1, label: t("fop.tx.yes") },
    { v: 0, label: t("fop.tx.no") },
  ];

  return (
    <div className="fop-tx">
      <span className="fop-tx-label">{t("fop.tx.label")}</span>
      <div className="seg">
        {options.map((o) => (
          <button
            key={String(o.v)}
            className={value === o.v ? "active" : ""}
            disabled={isLoading}
            onClick={() => set(o.v)}
          >{o.label}</button>
        ))}
      </div>
      {/* Said where the decision is made, not only on /fop: somebody marking a purchase as a work
          expense will assume it lowers the tax. On the single tax it does not. */}
      <span className="fop-tx-note">{t("fop.tx.note")}</span>
    </div>
  );
}
