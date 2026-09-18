import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import { Icon } from "../ui/Icon.tsx";
import { MarkPaid } from "./MarkPaid.tsx";
import type { TaxStatus } from "../../store/api.ts";

/**
 * §TAX-DUE — every deadline, not only the next one.
 *
 * The header answers «what is closest», which is the right question on the day you open the page
 * and the wrong one when you are planning a quarter: group 1 and 2 owe something on the 20th of
 * EVERY month, and a screen that shows one of them tells a monthly payer nothing about the
 * remaining eleven. The money is already accrued (§TAX-RESERVE) — this is the same rows, laid out
 * in the order they come due.
 *
 * ⚠️ Unpaid first, then what is settled — and the settled ones stay on the list rather than
 * disappearing. «Did I already pay the second quarter» is exactly the question this card exists
 * to answer, and a list that only shows debts cannot answer it.
 *
 * No new request: `/tax/status` already returns every obligation from the start of the previous
 * year (the window that carries a Q4 paid in February), so this is a second reading of the shell's
 * one payload — the same rule `Stats.tsx` keeps.
 */
const PAID_FOLD = 6;

export function TaxCalendar({ status }: { status: TaxStatus }) {
  const t = useT();
  const [showPaid, setShowPaid] = useState(false);
  // Chronological, and the sort is on the DATE STRING: both sides are 'YYYY-MM-DD' in Kyiv
  // (§APP_TZ), so comparing them as text compares dates and never drifts into a timezone.
  const rows = [...status.obligations].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const unpaid = rows.filter((o) => !o.paid_tx_id);
  const paid = rows.filter((o) => o.paid_tx_id);
  if (!rows.length) return null;

  return (
    <div className="card">
      <div className="section-head"><h3>{t("fop.calendar")}</h3></div>
      <div className="fop-cal">
        {unpaid.map((o) => (
          <div key={o.id} className={`fop-cal-row ${o.overdue ? "overdue" : ""}`}>
            <span className="fop-cal-when">{o.due_date}</span>
            <span className="fop-cal-kind">
              {t(`fop.kind.${o.kind}` as never)} <span className="fop-cal-period">{o.period}</span>
            </span>
            <Money minor={o.amount} currency={HRYVNIA} decimals={false} />
            <MarkPaid obligationId={o.id} />
          </div>
        ))}
        {/* ⚠️ THE GROUP 1–2 CASE, which is the one nobody draws. They owe ЄП and ВЗ every MONTH,
            so a year is ~28 rows and two years is ~56 — and the settled ones are the majority.
            Unpaid always show in full (they are the point); the paid history folds once it stops
            being a list and starts being an archive. Six is where a column stops being scannable. */}
        {paid.length > PAID_FOLD && !showPaid && (
          <button className="fop-cal-more" onClick={() => setShowPaid(true)}>
            {t("fop.calShowPaid", { n: String(paid.length) })}
          </button>
        )}
        {(paid.length <= PAID_FOLD || showPaid) && paid.map((o) => (
          <div key={o.id} className="fop-cal-row paid">
            <span className="fop-cal-when">{o.due_date}</span>
            <span className="fop-cal-kind">
              {t(`fop.kind.${o.kind}` as never)} <span className="fop-cal-period">{o.period}</span>
            </span>
            <Money minor={o.amount} currency={HRYVNIA} decimals={false} />
            <span className="fop-cal-state"><Icon name="check" size={13} /> {t("fop.calPaid")}</span>
          </div>
        ))}
      </div>
      {!unpaid.length && <p className="fop-note">{t("fop.calAllPaid")}</p>}
    </div>
  );
}
