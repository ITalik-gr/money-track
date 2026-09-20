import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { Icon } from "../ui/Icon.tsx";
import { HRYVNIA, hryvniaSign } from "../../../shared/currency.ts";
import { StatKpiInner } from "../stats/shared.tsx";
import { BizMonths } from "./BizMonths.tsx";
import type { BusinessOverview, TaxStatus } from "../../store/api.ts";

/**
 * The business at a glance — the tab somebody opens to answer «how is it going», not «what do I owe».
 *
 * §BIZ-SPLIT: every figure here is true of a business with no ФОП at all. The tax only ever
 * SUBTRACTS — it turns «earned minus costs» into «earned minus costs minus what the state takes» —
 * so with the module off the same three tiles still say something complete, rather than showing a
 * hole where a tax figure would be.
 *
 * ⚠️ §TAX-UAH — hryvnia throughout, `hryvniaSign()`, never `baseSign()`.
 *
 * ⚠️ `StatKpiInner` is borrowed from the Statistics domain on purpose: a KPI tile with a delta is
 * a pattern this app already has, and a second one drawn here would make two screens that mean the
 * same thing look like they mean different things (DESIGN.md §4).
 */
export function BizOverview({ data, status }: { data: BusinessOverview; status: TaxStatus }) {
  const t = useT();
  const taxOn = status.enabled;
  const q = data.quarters.at(-1);
  const prev = data.quarters.at(-2);
  const o = data.outlook;

  const income = q?.income ?? 0;
  const costs = q?.expenses ?? 0;
  const tax = taxOn ? (q?.tax ?? 0) : 0;
  const net = income - costs - tax;
  // Margin, not «profit»: the word profit implies an accounting result this app does not produce
  // (no depreciation, no accruals, no owner's draw). What it does know is what came in, what went
  // out, and what the state takes — and the ratio of those is a margin.
  const marginPct = income > 0 ? Math.round((net / income) * 1000) / 10 : null;

  return (
    <>
      <div className="biz-kpis">
        <div className="card kpi-tile">
          <StatKpiInner title={t("fop.qIncome")} minor={income} prev={prev?.income} sign={hryvniaSign()} goodWhenUp />
        </div>
        <div className="card kpi-tile">
          <StatKpiInner title={t("fop.qCosts")} minor={costs} prev={prev?.expenses} sign={hryvniaSign()} />
        </div>
        <div className="card kpi-tile">
          <StatKpiInner
            title={taxOn ? t("fop.qNetAfterTax") : t("fop.qNet")}
            minor={net}
            prev={prev ? prev.income - prev.expenses - (taxOn ? prev.tax : 0) : undefined}
            sign={hryvniaSign()}
            tone={net < 0 ? "neg" : undefined}
            goodWhenUp
          />
        </div>
      </div>

      <div className="card">
        <div className="section-head"><h3>{t("fop.shape")}</h3></div>
        <div className="biz-fact-grid">
          <div className="biz-fact">
            <i>{t("fop.margin")}</i>
            <b>{marginPct == null ? "—" : `${marginPct}%`}</b>
            <small>{t("fop.marginNote")}</small>
          </div>
          <div className="biz-fact">
            <i>{t("fop.share")}</i>
            {/* The one figure that says whether this page is about a side project or about the
                whole livelihood — and the reason it is here rather than on the clients tab: it
                changes how every other number on this screen should be read. */}
            <b>{data.share_pct == null ? "—" : `${data.share_pct}%`}</b>
            <small>{t("fop.shareNote")}</small>
          </div>
          <div className="biz-fact">
            <i>{t("fop.pace")}</i>
            <b>{o.projected_income == null
              ? t("fop.paceUnknown")
              : <Money minor={o.projected_income} currency={HRYVNIA} decimals={false} />}</b>
            {/* §CADENCE — «at this pace» is refused, not guessed, while the quarter is too young
                for a pace to mean anything. A projection off four days is a rumour with a number. */}
            <small>{o.projected_income == null
              ? t("fop.paceTooEarly")
              : t("fop.paceNote", { n: String(o.days_left) })}</small>
          </div>
          <div className="biz-fact">
            <i>{t("fop.concentration")}</i>
            <b>{data.top_share_pct == null ? "—" : `${data.top_share_pct}%`}</b>
            <small>{data.counterparties[0]
              ? t("fop.concentrationNote", { name: data.counterparties[0].name })
              : t("fop.noClients")}</small>
          </div>
        </div>
      </div>

      {/* The two things on this page that are NEWS rather than numbers. Both are read from the
          same lists the notification feed speaks from, so a message and the screen can never name
          different clients or a different deadline. */}
      {data.quiet.length > 0 && (
        <div className="card biz-alert warn">
          <Icon name="info" size={16} />
          <div>
            <b>{t("fop.quietTitle")}</b>
            <p className="fop-note">
              {data.quiet.map((c) => t("fop.quietOne", {
                name: c.name, days: String(c.days_since_last), gap: String(c.median_gap_days),
              })).join(" ")}
            </p>
          </div>
        </div>
      )}

      {taxOn && data.cash_gap && (
        <div className="card biz-alert neg">
          <Icon name="info" size={16} />
          <div>
            <b>{t("fop.cashGapTitle")}</b>
            {/* §TAX-DUE meets §RHYTHM — the payment falls due BEFORE the receipt that would pay
                it is expected. Said as a number of days, because «arrange it earlier» is the only
                action available and it needs to know how much earlier. */}
            <p className="fop-note">
              {t("fop.cashGapBody", {
                due: data.cash_gap.due_date,
                amount: `${Math.round(data.cash_gap.amount / 100).toLocaleString()} ${hryvniaSign()}`,
                expected: data.cash_gap.expected_income,
                days: String(data.cash_gap.days_short),
              })}
            </p>
          </div>
        </div>
      )}

      <BizMonths data={data} />
    </>
  );
}
