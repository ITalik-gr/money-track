import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import type { BusinessOverview } from "../../store/api.ts";

/**
 * What the business itself costs, by category — the spending side of §TAX-BASE.
 *
 * ⚠️ This is a REPORT, and the card says so out loud. On the single tax an expense does NOT reduce
 * the base, and somebody who sees «робочі витрати» next to a tax figure will reasonably assume the
 * first lowers the second and act on it — by marking more purchases as work, which changes nothing
 * except this list. The sentence is the feature; the numbers are the easy part.
 *
 * Reuses `.fop-rank`, the same proportion-bar row `Counterparties` uses: «this row is this big a
 * share» already has a visual vocabulary on this page, and a second one would make two lists that
 * mean the same thing look like they mean different things.
 */
export function BusinessCosts({ data }: { data: BusinessOverview }) {
  const t = useT();
  const rows = data.costs;
  const peak = rows[0]?.uah || 1;
  const total = rows.reduce((n, r) => n + r.uah, 0);

  return (
    <div className="card">
      <div className="section-head">
        <h3>{t("fop.costsBreakdown")}</h3>
        {total > 0 && <Money minor={total} currency={HRYVNIA} decimals={false} />}
      </div>
      {/* The existing short sentence («a report, not a deduction») plus the one fact that is
          specific to this list: what it leaves out, and why leaving it out is the honest
          choice rather than an omission. */}
      <p className="fop-note">{t("fop.costsNote")} {t("fop.costsFx")}</p>
      {rows.length === 0 ? (
        <EmptyCard icon="tx" title={t("fop.noCosts")} hint={t("fop.noCostsHint")} />
      ) : (
        <div className="fop-ranks">
          {rows.map((r) => (
            <div key={r.category_id} className="fop-rank">
              <div className="fop-rank-bar" style={{ width: `${(r.uah / peak) * 100}%` }} />
              <span className="fop-rank-name">{r.name}</span>
              <span className="fop-rank-n">{t("fop.nOps", { n: String(r.n) })}</span>
              <Money minor={r.uah} currency={HRYVNIA} decimals={false} className="fop-rank-sum" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
