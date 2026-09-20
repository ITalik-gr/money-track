import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import { Counterparties } from "./Counterparties.tsx";
import type { BusinessOverview } from "../../store/api.ts";

/**
 * The income side: who pays, with what rhythm, and who has stopped.
 *
 * §RHYTHM — `quiet` has existed since the tax module shipped and was visible ONLY as a
 * notification. A signal that can be missed by having notifications muted, and that has no screen
 * to go and check, is a signal the app cannot be asked about. It is the same list the feed speaks
 * from — one definition, so a message and this card can never name different clients.
 *
 * ⚠️ `warn`, never `urgent`, and worded as an observation. A client may have paused for a reason
 * the app cannot see — a holiday, a project between phases, an invoice not yet sent. The app
 * reports a rhythm that broke; it does not assert that something is wrong.
 */
export function BizClients({ data }: { data: BusinessOverview }) {
  const t = useT();

  return (
    <>
      <Counterparties data={data} />

      <div className="card">
        <div className="section-head"><h3>{t("fop.quietTitle")}</h3></div>
        {data.quiet.length === 0 ? (
          <p className="fop-note">{t("fop.quietNone")}</p>
        ) : (
          <div className="biz-quiet">
            {data.quiet.map((c) => (
              <div key={c.name} className="biz-quiet-row">
                <div className="biz-quiet-main">
                  <span className="biz-quiet-name">{c.name}</span>
                  <Money minor={c.avg_uah} currency={HRYVNIA} decimals={false} />
                </div>
                <div className="biz-quiet-sub">
                  {t("fop.quietOne", {
                    name: c.name, days: String(c.days_since_last), gap: String(c.median_gap_days),
                  })}
                  {" · "}{t("fop.nPayments", { n: String(c.n) })}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="fop-note">{t("fop.quietNote")}</p>
      </div>
    </>
  );
}
