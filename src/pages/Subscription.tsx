import { Link, useParams } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { useGetSubscriptionOverviewQuery } from "../store/api.ts";
import { Money } from "../components/ui/Money.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { EmptyCard } from "../components/ui/EmptyCard.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { CHART_ANIM } from "../lib/motion.ts";
import { currencySign } from "../../shared/currency.ts";

/**
 * §SUB-PAGE — one subscription, the way §CATEGORY-PAGE is one category.
 *
 * A plan was a row on a list: a name, an amount, a next date. None of those is what a person wants
 * to know about a subscription. This page answers the five questions that decide whether it stays:
 * what it has cost so far, whether it got more expensive, whether it is billed as often as the
 * plan claims, what it costs a year, and how big it is next to everything else.
 *
 * Every figure is server-computed canon (`subscription-overview.ts`). Nothing is recomputed here —
 * the page and the Advisor must not be able to disagree about the same subscription.
 */
const fmt0 = numFmt({ maximumFractionDigits: 0 });
const fmtDay = dateFmt({ day: "numeric", month: "short", year: "numeric" });
const fmtShort = dateFmt({ day: "numeric", month: "short" });

/** A cadence this far from the declared one is a fact about the plan, not rounding. */
const CADENCE_TOLERANCE = 0.25;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChargeTip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />{fmt0.format(p.amount)} {p.sign}</div>
    </div>
  );
}

export function Subscription() {
  const t = useT();
  const id = Number(useParams().id);
  const { data, isError, error, refetch } = useGetSubscriptionOverviewQuery(id, { skip: !Number.isFinite(id) });

  if (isError) return <ErrorNote error={error} what={t("nav.subs")} onRetry={refetch} />;
  if (!data) return null;
  const { plan, actual, share } = data;

  // The chart is drawn in the BILLED currency when every charge shares one — that is where a price
  // rise is visible at all. A mixed history (the biller switched currency) has no such axis, so it
  // falls back to the reader's unit and says so by using the base sign.
  const oneCurrency = data.charges.length > 0 && data.charges.every((c) => c.currency_code === data.charges[0].currency_code);
  const chartSign = currencySign(oneCurrency ? data.charges[0].currency_code : 980);
  const chart = [...data.charges].reverse().map((c) => ({
    label: fmtShort.format(new Date(c.time * 1000)),
    amount: Math.round((oneCurrency ? c.amount : c.amount_base) / 100),
    sign: chartSign,
  }));
  // The declared price as a line across the chart: "is it more than I signed up for" is a
  // comparison, and a comparison needs both things in one picture.
  const declaredLine = oneCurrency && plan.period_amount && plan.currency_code === data.charges[0].currency_code
    ? Math.round(plan.period_amount / 100) : null;

  const drifted = actual.real_interval_days != null
    && Math.abs(actual.real_interval_days - actual.declared_interval_days) > actual.declared_interval_days * CADENCE_TOLERANCE;

  return (
    <>
      <div className="page-head">
        <div className="sub-page-id">
          <MerchantLogo merchant={plan.title} color="var(--accent)" fallbackLabel={plan.title} />
          <div>
            <div className="greet">{plan.title}</div>
            <div className="sub">
              {plan.category_id != null && plan.category_name
                ? <Link to={`/categories/${plan.category_id}`}>{plan.category_name}</Link>
                : t("subp.noCategory")}
              {!plan.is_active && <> · {t("sub.ended")}</>}
            </div>
          </div>
        </div>
        <div className="page-head-actions">
          <Link className="btn ghost" to="/subs">{t("sub.backToList")}</Link>
        </div>
      </div>

      <div className="cat-page-stats">
        {/* The monthly burden FIRST — the canonical §SUB-MONTH figure, a quarterly plan already
            divided by three. It is the number every other screen uses for this plan. */}
        <div className="card merchant-stat">
          <div className="label">
            {t("subp.perMonth")}
            <InfoTip>{t("sub.perMonthHint")}</InfoTip>
          </div>
          <div className="merchant-stat-v num-hero"><Money minor={plan.monthly_base} decimals={false} /></div>
          <div className="merchant-stat-sub">{t("subp.perYear")} <Money minor={data.annual_base} decimals={false} /></div>
        </div>

        {/* What it has ALREADY cost — the figure that actually decides whether to cancel, and the
            one the app could not answer at all before this page existed. */}
        <div className="card merchant-stat">
          <div className="label">{t("sub.paidTotal")}</div>
          <div className="merchant-stat-v num-hero">
            {actual.n > 0 ? <Money minor={actual.total_base} decimals={false} /> : "—"}
          </div>
          <div className="merchant-stat-sub">
            {actual.n > 0 && actual.first_time
              ? t("sub.paidSince", { n: actual.n, date: fmtDay.format(new Date(actual.first_time * 1000)) })
              : t("sub.noCharges")}
          </div>
        </div>

        <div className="card merchant-stat">
          <div className="label">{t("sub.nextCharge")}</div>
          <div className="merchant-stat-v num-hero">
            {data.next_charge ? t("sub.inDays", { n: data.next_charge.in_days }) : "—"}
          </div>
          <div className="merchant-stat-sub">
            {data.next_charge
              ? fmtDay.format(new Date(data.next_charge.at * 1000))
              : t("sub.noNextCharge")}
          </div>
        </div>

        {/* Price: the plan against the last real charge, both in the currency BILLED. An exchange
            rate move is not the biller charging more, so comparing in the reader's unit would
            invent price rises. */}
        <div className="card merchant-stat">
          <div className="label">
            {t("sub.lastCharged")}
            <InfoTip>{t("sub.lastChargedHint")}</InfoTip>
          </div>
          <div className="merchant-stat-v num-hero">
            {actual.last_amount != null
              ? <Money minor={actual.last_amount} currency={actual.last_currency ?? undefined} decimals={false} />
              : "—"}
          </div>
          <div className="merchant-stat-sub">
            {actual.price_change_pct == null
              ? (plan.period_amount ? <>{t("sub.declared")} <Money minor={plan.period_amount} currency={plan.currency_code} decimals={false} /></> : "")
              : actual.price_change_pct === 0
                ? t("sub.priceSame")
                : <span className={actual.price_change_pct > 0 ? "neg" : "pos"}>
                    {t(actual.price_change_pct > 0 ? "sub.priceUp" : "sub.priceDown", { pct: Math.abs(actual.price_change_pct) })}
                  </span>}
          </div>
        </div>
      </div>

      {/* §SUB-PAGE: the real cadence. "Monthly" is what the plan says; a biller charging every 14
          days, or one that quietly stopped, is exactly what nobody could see before. */}
      {actual.real_interval_days != null && (
        <div className={`card sub-cadence ${drifted ? "warn" : ""}`}>
          <div>
            <div className="label">{t("sub.cadence")}</div>
            <div className="sub-cadence-v">
              {t("sub.everyNDays", { n: actual.real_interval_days })}
              <span className="muted"> · {t("sub.declaredEvery", { n: actual.declared_interval_days })}</span>
            </div>
          </div>
          {drifted && <div className="sub-cadence-note">{t("sub.cadenceOff")}</div>}
        </div>
      )}

      <section>
        <div className="section-head">
          <h2>{t("sub.chargeHistory")}</h2>
          <span className="label">{t("sub.chargeHistorySub")}</span>
        </div>
        {chart.length > 1 ? (
          <div className="card chart-card">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: Y_AXIS_LEFT_MARGIN }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--ink-3)" />
                <YAxis {...Y_AXIS} tick={{ fontSize: 11 }} stroke="var(--ink-3)" />
                <Tooltip content={<ChargeTip />} cursor={{ fill: "var(--surface-2)" }} />
                {declaredLine != null && (
                  <ReferenceLine y={declaredLine} stroke="var(--ink-3)" strokeDasharray="4 4" />
                )}
                <Bar dataKey="amount" fill="var(--accent)" radius={[4, 4, 0, 0]} {...CHART_ANIM} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          // "No charges are linked" is a real and actionable state — it is what the feed means by
          // «списань не видно» — so it says what to do rather than showing an empty chart.
          <EmptyCard title={t("sub.noChargesTitle")} hint={t("sub.noChargesHint")} />
        )}
      </section>

      {/* How big is it, next to what? Three shares, because an amount alone is not a decision. */}
      <section>
        <div className="section-head"><h2>{t("sub.weight")}</h2></div>
        <div className="card sub-share">
          <ShareRow label={t("sub.ofSubs")} pct={share.of_subscriptions_pct} />
          <ShareRow label={t("sub.ofCategory", { cat: plan.category_name ?? "" })} pct={plan.category_name ? share.of_category_pct : null} />
          <ShareRow label={t("sub.ofBurn")} pct={share.of_burn_pct} />
        </div>
      </section>

      {data.charges.length > 0 && (
        <section>
          <div className="section-head"><h2>{t("sub.linkedTx")}</h2></div>
          <div className="card sub-charge-list">
            {data.charges.slice(0, 12).map((c) => (
              <Link key={c.id} className="sub-charge-row" to={`/transactions/${c.id}`}>
                <span>{fmtDay.format(new Date(c.time * 1000))}</span>
                <Money minor={c.amount} currency={c.currency_code} decimals={false} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ShareRow({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div className="sub-share-row">
      <span className="sub-share-lbl">{label}</span>
      <span className="sub-share-bar">
        {/* Clamped at 100: a plan can exceed its category's canonical level (the level is an
            average over months, a charge is not), and a bar running past its own track reads as a
            rendering bug rather than as the fact it is. */}
        <span style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <span className="sub-share-pct">{pct == null ? "—" : `${pct}%`}</span>
    </div>
  );
}
