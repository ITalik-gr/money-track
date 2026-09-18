import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import type { BusinessOverview } from "../../store/api.ts";

/**
 * WHO PAYS, and with what rhythm.
 *
 * The spending side has had a merchant view since the beginning; the income side had none — a
 * client was a string in the feed and no screen ever grouped by it. For a business that is the
 * more consequential half: concentration is a risk you can act on, and a client going quiet is
 * the earliest signal there is.
 *
 * ⚠️ Names are grouped EXACTLY as the bank sends them, not by a fuzzy root token the way merchant
 * matching works elsewhere. Merging two similar names on the spending side costs a wrong chart;
 * here it would merge two real clients and misstate what the business depends on.
 */
export function Counterparties({ data }: { data: BusinessOverview }) {
  const t = useT();
  const top = data.counterparties[0];
  const peak = Math.max(1, ...data.counterparties.map((c) => c.total_uah));
  const r = data.rhythm;

  return (
    <div className="card">
      <div className="section-head"><h3>{t("fop.clients")}</h3></div>

      <div className="fop-rhythm">
        <span className="fop-rhythm-item">
          <i>{t("fop.avgReceipt")}</i>
          <Money minor={r.avg_uah} currency={HRYVNIA} decimals={false} />
        </span>
        <span className="fop-rhythm-item">
          <i>{t("fop.gap")}</i>
          {/* MEDIAN, not mean: one three-month gap in an otherwise monthly year drags a mean past
              six weeks, and the reading becomes true of no month that actually happened. */}
          <b>{r.median_gap_days == null ? "—" : t("fop.days", { n: String(r.median_gap_days) })}</b>
        </span>
        <span className="fop-rhythm-item">
          <i>{t("fop.sinceLast")}</i>
          <b>{r.days_since_last == null ? "—" : t("fop.days", { n: String(r.days_since_last) })}</b>
        </span>
        {data.top_share_pct != null && top && (
          <span className="fop-rhythm-item">
            <i>{t("fop.concentration")}</i>
            {/* Named, not scored. Whether one client at 80% is a risk or a contract is the
                owner's call, and an app that graded it would be guessing at their business. */}
            <b>{t("fop.topShare", { pct: String(data.top_share_pct), name: top.name })}</b>
          </span>
        )}
      </div>

      {data.counterparties.length === 0 ? (
        <EmptyCard icon="tx" title={t("fop.noClients")} hint={t("fop.noClientsHint")} />
      ) : (
        <div className="fop-ranks">
          {data.counterparties.map((c) => (
            <div key={c.name} className="fop-rank">
              <div className="fop-rank-bar" style={{ width: `${(c.total_uah / peak) * 100}%` }} />
              <span className="fop-rank-name">{c.name}</span>
              <span className="fop-rank-n">{t("fop.nPayments", { n: String(c.n) })}</span>
              <Money minor={c.total_uah} currency={HRYVNIA} decimals={false} className="fop-rank-sum" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
