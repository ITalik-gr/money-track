import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA, hryvniaSign } from "../../../shared/currency.ts";
import { Gauge } from "../ui/Gauge.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MarkPaid } from "./MarkPaid.tsx";
import { useBackfillTaxRatesMutation } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import type { TaxStatus } from "../../store/api.ts";

/**
 * The three numbers the business owner opens this page for: what is already promised to the
 * state, when the next payment is due, and how much of the annual ceiling is left.
 *
 * ⚠️ §TAX-UAH — every `Money` here passes `currency={HRYVNIA}` explicitly. Omitting it would print the
 * reader's display base (§BASE-CUR), and a tax bill labelled in dollars is a figure that appears
 * on no document and that nobody can pay.
 */
export function TaxHeader({ status }: { status: TaxStatus }) {
  const t = useT();
  const [backfill, { isLoading: filling }] = useBackfillTaxRatesMutation();

  const limit = status.limit;
  const ratio = limit.limit > 0 ? limit.used / limit.limit : 0;
  // Three states, not two (§TAX-LIMIT). «Already over» is an event with consequences — a 15% rate
  // on the excess and a forced change of group — not a stronger shade of warning.
  const tone = limit.state === "exceeded" ? "neg" : limit.state === "projected" ? "warn" : "accent";

  return (
    <div className="fop-head">
      <div className="card fop-reserve">
        <div className="section-head"><h3>{t("fop.reserve")}</h3></div>
        <div className="fop-big"><Money minor={status.reserved} currency={HRYVNIA} decimals={false} /></div>
        {/* Said plainly, because it is the whole point of the number: this money is on the
            balance and is not the user's. It does NOT come out of the cushion (§TAX-RESERVE). */}
        <p className="fop-note">{t("fop.reserveNote")}</p>

        {status.next && (
          <div className={`fop-next ${status.next.days_left < 0 ? "overdue" : ""}`}>
            <div className="fop-next-main">
              <span className="fop-next-kind">{t(`fop.kind.${status.next.kind}` as never)}</span>
              <Money minor={status.next.amount} currency={HRYVNIA} decimals={false} />
            </div>
            <div className="fop-next-when">
              {status.next.days_left < 0
                ? t("fop.overdueBy", { n: String(-status.next.days_left) })
                : t("fop.dueIn", { n: String(status.next.days_left) })}
              {" · "}{status.next.due_date}
            </div>
            <MarkPaid obligationId={status.next.id} />
          </div>
        )}
      </div>

      <div className="card fop-limit">
        <div className="section-head"><h3>{t("fop.limit")}</h3></div>
        <Gauge
          ratio={ratio}
          center={`${limit.pct}%`}
          // §TAX-UAH — the sign comes from the code, not from the string. The i18n lint rightly
          // refuses a spelled-out ₴ in a translation (§BASE-CUR: the reader picks the base), and
          // `{cur}` would fill in THEIR base — which for a tax ceiling would be the wrong unit.
          sub={t("fop.limitOf", { total: `${Math.round(limit.limit / 100).toLocaleString()} ${hryvniaSign()}` })}
          tone={tone}
        />
        <div className="fop-limit-state">
          {limit.state === "exceeded" && <span className="fop-warn">{t("fop.limitOver")}</span>}
          {limit.state === "projected" && limit.projected_date && (
            <span className="fop-warn">{t("fop.limitProjected", { date: limit.projected_date })}</span>
          )}
          {limit.state === "ok" && <span className="fop-ok">{t("fop.limitOk")}</span>}
        </div>

        {/* §TAX-LIMIT — the third state is an EVENT, not a louder warning, so it says what actually
            happens next instead of only that something is wrong: 15% on the excess and a change of
            group from the following quarter. And «how much is left» is stated whenever the ceiling
            is in play at all — a percentage answers «how far along», never «how much more can I
            invoice this year», which is the question somebody signing a contract is asking. */}
        {limit.state !== "ok" && (
          <div className="fop-limit-what">
            {limit.state === "exceeded"
              ? <p className="fop-note">{t("fop.limitOverWhat")}</p>
              : <p className="fop-note">
                  {t("fop.limitLeft", {
                    left: `${Math.round(Math.max(0, limit.limit - limit.used) / 100).toLocaleString()} ${hryvniaSign()}`,
                  })}
                </p>}
          </div>
        )}

        {/* §TAX-FX — receipts whose hryvnia base could not be fixed yet are REPORTED, never
            guessed: an income total quietly missing a $2 000 invoice reads as «you are nowhere
            near the limit», which is the one wrong answer here with a penalty attached. */}
        {status.missing_rate > 0 && (
          <div className="fop-missing">
            <Icon name="info" size={14} />
            <span>{t("fop.missingRate", { n: String(status.missing_rate) })}</span>
            <button
              className="btn sm"
              disabled={filling}
              onClick={async () => {
                try {
                  const r = await backfill().unwrap();
                  toast.info(t("fop.filled", { n: String(r.filled), left: String(r.remaining) }));
                } catch (e) { toast.error(errText(e)); }
              }}
            >{t("fop.fillRates")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
