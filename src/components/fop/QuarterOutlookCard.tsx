import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import type { BusinessOverview } from "../../store/api.ts";

/**
 * §BUDGET-PACE for the tax quarter, and the «which group» question beside it.
 *
 * TWO readings of one income figure. The first is planning: what is already accrued and what the
 * quarter will cost if the rest of it looks like the part that happened. The second is the
 * decision a ФОП actually revisits — group 1, 2 or 3 — priced on that same income, because the
 * published tables are a comparison of rates and not of what YOU would pay.
 *
 * ⚠️ Nothing is projected under a fortnight of quarter (`projected_income === null`). Income
 * arrives in lumps, and «at this pace» computed from one invoice on the 2nd is a confident
 * sentence about three months nobody has lived yet — so the card says «too early» instead.
 *
 * ⚠️ A group past its annual ceiling is shown STRUCK THROUGH, not merely cheaper. Group 1 charges
 * 332,80 ₴ a month and stops being available at 1 444 049 ₴ a year: a price without that fact
 * attached is an invitation to a decision the law does not allow.
 */
export function QuarterOutlookCard({ data, group }: { data: BusinessOverview; group: 1 | 2 | 3 }) {
  const t = useT();
  const o = data.outlook;

  return (
    <div className="card">
      <div className="section-head">
        <h3>{t("fop.outlook", { q: o.label })}</h3>
        <span className="muted">{t("fop.outlookDays", { n: String(o.days_left) })}</span>
      </div>

      <div className="fop-outlook">
        <div className="fop-outlook-cell">
          <span className="fop-outlook-label">{t("fop.outlookAccrued")}</span>
          <Money minor={o.accrued_now} currency={HRYVNIA} decimals={false} />
        </div>
        <div className="fop-outlook-cell">
          <span className="fop-outlook-label">{t("fop.outlookProjected")}</span>
          {o.projected_tax == null
            ? <span className="fop-muted">{t("fop.outlookTooEarly")}</span>
            : <Money minor={o.projected_tax} currency={HRYVNIA} decimals={false} />}
        </div>
        <div className="fop-outlook-cell">
          <span className="fop-outlook-label">{t("fop.outlookIncome")}</span>
          <Money minor={o.projected_income ?? o.income_so_far} currency={HRYVNIA} decimals={false} />
        </div>
      </div>

      {/* §TAX-DUE meets §RHYTHM. The one fact only this app can see: the deadline lands before
          the receipt that pays it. Stated as a date and a shortfall — what to do about it (invoice
          early, hold the reserve, pay from personal money) is the owner's call, and an app that
          recommended one would be advising on a cash position it can only partly see. */}
      {data.cash_gap && (
        <p className="fop-warn fop-gap">
          {t("fop.cashGap", {
            due: data.cash_gap.due_date,
            income: data.cash_gap.expected_income,
            n: String(data.cash_gap.days_short),
          })}
        </p>
      )}

      <div className="section-head"><h4>{t("fop.groupsTitle")}</h4></div>
      <p className="fop-note">{t("fop.groupsNote")}</p>
      <div className="fop-groups">
        {o.groups.map((g) => (
          // The user's own group is marked: a price list with no «you are here» makes the reader
          // find their own row before the comparison can mean anything.
          <div key={g.group} className={`fop-group ${g.over_limit ? "closed" : ""} ${g.group === group ? "mine" : ""}`}>
            <span className="fop-group-name">
              {t("fop.groupN", { n: String(g.group) })}
              {g.group === group && <span className="fop-group-mine">{t("fop.groupMine")}</span>}
            </span>
            <span className="fop-group-total"><Money minor={g.total} currency={HRYVNIA} decimals={false} /></span>
            <span className="fop-group-parts">
              {t("fop.groupParts")} <Money minor={g.tax} currency={HRYVNIA} decimals={false} />
              {" + "}<Money minor={g.esv} currency={HRYVNIA} decimals={false} />
            </span>
            {g.over_limit && <span className="fop-warn">{t("fop.groupClosed")}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
