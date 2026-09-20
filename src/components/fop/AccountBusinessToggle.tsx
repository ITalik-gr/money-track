import { useT } from "../../i18n/index.ts";
import { useSetAccountBusinessMutation, useGetTaxStatusQuery } from "../../store/api.ts";
import { useFopVisible } from "./gate.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";

/**
 * §TAX-BASE — «is this a ФОП account?», where the account is actually edited.
 *
 * It existed only as `POST /api/tax/accounts/:id/business` until now, so the one switch the whole
 * tax module depends on could be thrown only with curl: an account nobody marked makes every
 * receipt on it personal, and the ФОП screen then reports a quarter of zero income with no hint
 * as to why (`NIGHT.md` §3, and §0.2 of the same file — the owner's own setup step).
 *
 * TWO states here, not the three the OPERATION toggle has. `accounts.is_business` is
 * `NOT NULL DEFAULT 0`: there is no «nobody was asked» to represent, because the account is the
 * thing that answers for the rows that were never asked (§TAX-BASE).
 *
 * ⚠️ NOT a third value of `role`. `role` decides whether the money is part of the cushion;
 * this decides whose income it is. docs/TAX.md rejected merging them deliberately: the reserve
 * would then move runway, and «how long will the money last» would start depending on the tax
 * calendar.
 *
 * Renders nothing while the ФОП module is off — a question about a life the user may not lead.
 */
export function AccountBusinessToggle({ id, value }: { id: string; value: number }) {
  const t = useT();
  // §FOP-GATE — asked BEFORE the request, not after: a refused query would toast a 404 on a
  // screen that is meant to show nothing at all.
  const visible = useFopVisible();
  const { data: status } = useGetTaxStatusQuery(undefined, { skip: !visible });
  const [setBusiness, { isLoading }] = useSetAccountBusinessMutation();
  if (!visible || !status?.enabled) return null;

  const set = async (business: 0 | 1) => {
    try { await setBusiness({ id, business }).unwrap(); }
    catch (e) { toast.error(errText(e)); }
  };

  return (
    <div className="fop-tx">
      <span className="fop-tx-label">{t("fop.acct.label")}</span>
      <div className="seg">
        {([[1, t("fop.acct.yes")], [0, t("fop.acct.no")]] as const).map(([v, label]) => (
          <button
            key={v}
            className={(value ? 1 : 0) === v ? "active" : ""}
            disabled={isLoading}
            onClick={() => set(v)}
          >{label}</button>
        ))}
      </div>
      {/* Said here rather than only on /fop: this switch reaches BACKWARDS over the whole imported
          history of the account, which is the surprising half of §TAX-BASE. */}
      <span className="fop-tx-note">{t("fop.acct.note")}</span>
    </div>
  );
}
