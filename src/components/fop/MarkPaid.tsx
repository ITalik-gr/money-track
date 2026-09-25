import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import { useMarkTaxPaidMutation, useLazyGetTaxPaymentCandidatesQuery } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { localYmd } from "../../../shared/time.ts";

/**
 * §TAX-DUE — «paid» is a LINK to the operation that paid it, never a bare checkbox.
 *
 * The canon said this from the start and the button did not do it: it wrote the mark with no
 * `tx_id`, so the app knew only that somebody had pressed a button. With the link, the figures
 * reconcile themselves — «paid less than was accrued» is visible from the two amounts and needs
 * no second field — and this is the same shape §PLAN-LINK settled for subscriptions.
 *
 * ⚠️ The app PROPOSES and the human CHOOSES. An automatic link on the closest amount would be the
 * app asserting which payment settled which quarter, and being wrong about that is worse than
 * leaving it unlinked: the obligation would read as settled by a row that paid something else.
 *
 * ⚠️ «Without an operation» stays available, and stays secondary. Somebody who paid from a bank
 * this app does not see still has to be able to close the deadline; refusing them would make the
 * link a wall rather than a record.
 */
export function MarkPaid({ obligationId }: { obligationId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [markPaid, { isLoading: saving }] = useMarkTaxPaidMutation();
  const [load, { data, isFetching }] = useLazyGetTaxPaymentCandidatesQuery();

  const settle = async (txId: string | null) => {
    try {
      await markPaid({ id: obligationId, tx_id: txId }).unwrap();
      setOpen(false);
    } catch (e) { toast.error(errText(e)); }
  };

  if (!open) {
    return (
      <button
        className="btn sm"
        onClick={() => { setOpen(true); void load(obligationId); }}
      >{t("fop.markPaid")}</button>
    );
  }

  return (
    <div className="fop-paid">
      <div className="fop-paid-head">{t("fop.paidPick")}</div>
      {isFetching && <div className="fop-paid-empty">{t("common.loading")}</div>}
      {!isFetching && data?.candidates.length === 0 && (
        <div className="fop-paid-empty">{t("fop.paidNone")}</div>
      )}
      {data?.candidates.map((c) => (
        <button key={c.id} className="fop-paid-row" disabled={saving} onClick={() => settle(c.id)}>
          <span className="fop-paid-when">{localYmd(c.time)}</span>
          <span className="fop-paid-who">{c.merchant ?? t("fop.paidNoName")}</span>
          {/* §TAX-UAH — the candidate query only ever returns hryvnia rows, and the amount is
              printed in the currency it was paid in, not in the reader's base. */}
          <Money minor={-c.amount} currency={HRYVNIA} decimals={false} />
        </button>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn ghost sm" disabled={saving} onClick={() => settle(null)}>{t("fop.paidNoTx")}</button>
        <button className="btn ghost sm" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}
