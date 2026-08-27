import { Link, useParams } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { useGetSubscriptionOverviewQuery, useRelinkPlannedMutation } from "../store/api.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
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
  const [relink, { isLoading: relinking }] = useRelinkPlannedMutation();

  async function findMissing() {
    try {
      const r = await relink(id).unwrap();
      toast[r.linked > 0 ? "success" : "info"](
        r.linked > 0 ? t("sub.relinkDone", { n: r.linked }) : t("sub.relinkNone"),
      );
    } catch (e) { toast.error(errText(e)); }
  }

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
  /**
   * The declared price as a line across the chart: "is it more than I signed up for" is a
   * comparison, and a comparison needs both things in one picture.
   *
   * ⚠️ NOT rounded (2026-08-27). It was `Math.round(period_amount / 100)`, which threw away
   * exactly the difference the line exists to show: a plan declared at 43.56 against charges of
   * 44.00 rounds to the same 44, so the line landed precisely on the bar tops and was invisible —
   * while the card beside it said «на 1% дорожче за план». The chart was contradicting its own
   * page, and it looked like a missing feature rather than a wrong one.
   */
  const declaredLine = oneCurrency && plan.period_amount && plan.currency_code === data.charges[0].currency_code
    ? plan.period_amount / 100 : null;
  // Headroom, so a line at or above the tallest bar is never flush with the top of the plot. With
  // Recharts' default domain the axis maximum IS the data maximum, and a reference line drawn
  // there has no pixels to occupy.
  // ⚠️ ROUNDED UP to a readable step, not `max × 1.18` (2026-08-27). Recharts prints the domain
  // bound as a tick verbatim, so a raw float put «51.919999999999995» on the axis — a number that
  // is not a price, in a place where every other number is one. The headroom still has to exist
  // (a reference line at the data max has no pixels), it just has to land somewhere sayable.
  const rawMax = Math.max(...chart.map((c) => c.amount), declaredLine ?? 0) * 1.18;
  const step = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(rawMax, 1))) - 1));
  const chartMax = Math.max(step, Math.ceil(rawMax / step) * step);

  // §RHYTHM: a plan that bills on a FIXED DAY is doing exactly what it claims, whatever the gap
  // in days works out to (28 to 31, depending on the month). Warning about drift there is the app
  // arguing with a subscription that has never once been late — which is what it did about Apple,
  // billed on the 6th without fail, because one charge was not linked and a MEAN interval read 41.
  const drifted = actual.billing_day == null && actual.real_interval_days != null
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
              {/* The billing DAY first when there is one: it is the fact the person can check
                  against their own memory, and an interval is only a derived quantity. */}
              {actual.billing_day != null
                ? t("sub.billingDay", { n: actual.billing_day })
                : t("sub.everyNDays", { n: actual.real_interval_days })}
              <span className="muted"> · {t("sub.declaredEvery", { n: actual.declared_interval_days })}</span>
            </div>
          </div>
          {drifted && <div className="sub-cadence-note">{t("sub.cadenceOff")}</div>}
          {/* A gap twice the usual one is either a month the biller skipped or a charge nothing
              linked — and a missing charge is exactly what nobody goes looking for (§SUB-DATE). */}
          {actual.skipped_gaps > 0 && (
            <div className="sub-cadence-note">
              {t("sub.skipped", { n: actual.skipped_gaps })}
              <InfoTip>{t("sub.skippedHint")}</InfoTip>
              {/* §PLAN-LINK: the commonest cause is a charge nothing attached, and the page can
                  fix that itself. Pointing at a problem you could solve and not offering to is
                  worse than staying quiet. */}
              <button className="btn ghost sm" disabled={relinking} onClick={findMissing}>{t("sub.relink")}</button>
            </div>
          )}
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
                <YAxis {...Y_AXIS} tick={{ fontSize: 11 }} stroke="var(--ink-3)" domain={[0, chartMax]} />
                <Tooltip content={<ChargeTip />} cursor={{ fill: "var(--surface-2)" }} />
                {declaredLine != null && (
                  // Labelled and in the warning colour: an unlabelled dashed line near the bar
                  // tops is indistinguishable from grid work, which is how this one went unnoticed.
                  <ReferenceLine y={declaredLine} stroke="var(--c-ochre)" strokeDasharray="5 4" strokeWidth={1.5}
                    label={{ value: `${t("sub.declaredLine")} ${fmt0.format(declaredLine)}`, position: "insideTopLeft", fill: "var(--c-ochre)", fontSize: 11, offset: 6 }} />
                )}
                <Bar dataKey="amount" fill="var(--accent)" radius={[4, 4, 0, 0]} {...CHART_ANIM} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          // THREE states, not two (2026-08-27). A single charge plots nothing, but it is not
          // "no charges" — and the old gate (`> 1`) said «списань не видно» directly above the
          // section that then listed that very charge. The app contradicting itself on one screen
          // is worse than either half of it being wrong.
          <EmptyCard
            title={t(data.charges.length === 0 ? "sub.noChargesTitle" : "sub.oneChargeTitle")}
            hint={t(data.charges.length === 0 ? "sub.noChargesHint" : "sub.oneChargeHint")}
          />
        )}
      </section>

      {/* §PRICE-STEPS — WHEN the price moved, not just whether it is high today.
          The card above compares the latest charge to the declared amount, which says nothing
          about when it changed — and "it went up in June" is the half that decides whether to
          keep it. One entry means it has never changed, and saying so is worth a line: a section
          that disappears when the answer is "no change" makes the reader wonder if it broke. */}
      {data.price_steps.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("sub.priceSteps")}</h2>
            <span className="label">{t("sub.priceStepsSub")}</span>
          </div>
          {data.price_steps.length === 1 ? (
            <div className="card sub-price-one">
              <Money minor={data.price_steps[0].amount} currency={data.price_steps[0].currency_code} decimals={false} />
              <span className="muted">{t("sub.priceNeverChanged")}</span>
            </div>
          ) : (
            <div className="card sub-price-steps">
              {data.price_steps.map((st, i) => {
                const prev = i > 0 ? data.price_steps[i - 1] : null;
                // Only against the PREVIOUS step, and only within one currency — a biller that
                // switched from dollars to hryvnia did not raise its price by 4 000%.
                const delta = prev && prev.currency_code === st.currency_code ? st.amount - prev.amount : null;
                return (
                  <div className="sub-price-step" key={st.since}>
                    <span className="sps-amt"><Money minor={st.amount} currency={st.currency_code} decimals={false} /></span>
                    <span className="sps-since">{t("sub.priceStepSince", { date: fmtDay.format(new Date(st.since * 1000)) })}</span>
                    <span className="sps-n muted">{t("sub.priceStepN", { n: st.n })}</span>
                    {delta != null && delta !== 0 && (
                      <span className={`sps-delta ${delta > 0 ? "neg" : "pos"}`}>
                        {delta > 0 ? "+" : "−"}<Money minor={Math.abs(delta)} currency={st.currency_code} decimals={false} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

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
              <Link key={c.id} className="sub-charge-row" to={`/tx/${c.id}`}>
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
