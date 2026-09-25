/**
 * §SUB-STACK on the Subscriptions page — the questions ABOVE the rows.
 *
 * The hero already says what the plans cost per month. This card says what nobody sees from a list:
 * what the plans ACTUALLY took month by month over the last year (real charges, so a price rise is in
 * it the day it lands), whether that total drifted, which two plans look like the same kind of thing,
 * and which trial has just turned into a full charge.
 *
 * ⚠️ Two-of-a-kind is a QUESTION («обидві потрібні?»), never an accusation — two plans in one
 * category may be a household's two phones. ⚠️ The card is silent when it has nothing to say: an
 * empty history, no drift, no pairs, no trials — no filler.
 */
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { Money } from "../ui/Money.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { HoverTip } from "../ui/HoverTip.tsx";
import { useGetSubStackQuery } from "../../store/api.ts";

const fmtMonth = dateFmt({ month: "short" });
const fmtDay = dateFmt({ day: "numeric", month: "short" });
const fmtMonthLong = dateFmt({ month: "long", year: "numeric" });
const monthLabel = (ym: string) => fmtMonth.format(new Date(`${ym}-15T12:00:00Z`));

export function SubsStackCard() {
  const t = useT();
  const { data } = useGetSubStackQuery();
  if (!data) return null;
  const hasHistory = data.paid.length >= 2;
  if (!hasHistory && !data.duplicates.length && !data.trials.length) return null;
  const max = Math.max(1, ...data.paid.map((p) => p.paid));
  const total = data.paid.reduce((sum, p) => sum + p.paid, 0);
  const avg = data.paid.length ? Math.round(total / data.paid.length) : 0;
  const peak = data.paid.reduce<(typeof data.paid)[number] | null>((m, p) => (!m || p.paid > m.paid ? p : m), null);

  return (
    <div className="card stack-card">
      <div className="ai-head">
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            {t("stack.title")}
            <InfoTip>{t("stack.tip")}</InfoTip>
          </div>
          <div className="label">{t("stack.sub")}</div>
        </div>
        {/* Rising is red, falling is green — the tone follows the value (DESIGN §6). */}
        {data.drift && data.drift.pct !== 0 && (
          <span className={`stack-drift ${data.drift.pct > 0 ? "neg" : "pos"}`}>
            {data.drift.pct > 0 ? "+" : "−"}{Math.abs(data.drift.pct)}%
          </span>
        )}
      </div>

      {data.drift && (
        <p className="stack-drift-said">
          {t(data.drift.pct >= 0 ? "stack.driftUp" : "stack.driftDown", { pct: Math.abs(data.drift.pct) })}{" "}
          <Money minor={data.drift.from_avg} decimals={false} /> → <Money minor={data.drift.to_avg} decimals={false} />
          {t("stack.perMonthSuffix")}
        </p>
      )}

      {/* What the year of charges ADDS UP to, and its worst month — the two facts a column chart
          makes you estimate. (The monthly price of the plans is the page hero's; not repeated.) */}
      {hasHistory && peak && (
        <div className="stack-figs">
          <span>{t("stack.totalFor", { n: data.paid.length })} <b><Money minor={total} decimals={false} /></b></span>
          <span>{t("stack.peak", { month: fmtMonthLong.format(new Date(`${peak.ym}-15T12:00:00Z`)) })} <b><Money minor={peak.paid} decimals={false} /></b></span>
        </div>
      )}

      {hasHistory && (
        <div className="stack-chart" role="img" aria-label={t("stack.chartLabel")}>
          <div className="stack-plot">
            {data.paid.map((p, i) => {
              const prev = i > 0 ? data.paid[i - 1].paid : null;
              const pct = prev ? Math.round(((p.paid - prev) / prev) * 100) : null;
              const rest = p.top.reduce((sum, x) => sum - x.paid, p.paid);
              return (
                <HoverTip key={p.ym} content={
                  <>
                    <div className="tip-lbl">{fmtMonthLong.format(new Date(`${p.ym}-15T12:00:00Z`))}</div>
                    <div className="tip-big"><Money minor={p.paid} decimals={false} /></div>
                    <div className="tip-muted">
                      {t("stack.tipCharges", { n: p.n })}
                      {pct != null && pct !== 0 && <> · <span className={pct > 0 ? "tip-neg" : "tip-pos"}>{pct > 0 ? "+" : "−"}{Math.abs(pct)}%</span> {t("spark.vsMonth", { month: monthLabel(data.paid[i - 1].ym) })}</>}
                    </div>
                    {p.top.length > 0 && (
                      <div className="tip-sec">
                        {p.top.map((x) => (
                          <div key={x.title} className="tip-kv"><span>{x.title}</span><span><Money minor={x.paid} decimals={false} /></span></div>
                        ))}
                        {rest > 0 && <div className="tip-kv"><span>{t("stack.tipOther")}</span><span><Money minor={rest} decimals={false} /></span></div>}
                      </div>
                    )}
                  </>
                }>
                  <span className="stack-bar">
                    <i style={{ height: `${p.paid > 0 ? Math.max(3, (p.paid / max) * 100) : 0}%` }} />
                  </span>
                </HoverTip>
              );
            })}
            {/* The average as a line across the columns: «is this month high?» is a question about
                the average, and without the line the eye has to estimate it from twelve heights. */}
            {avg > 0 && (
              <span className="stack-avg" style={{ bottom: `${(avg / max) * 100}%` }}>
                <span className="stack-avg-chip">{t("stack.avg")} <Money minor={avg} decimals={false} /></span>
              </span>
            )}
          </div>
          <div className="stack-months">
            {data.paid.map((p) => <span key={p.ym}>{monthLabel(p.ym)}</span>)}
          </div>
        </div>
      )}

      {data.trials.length > 0 && (
        <div className="stack-block">
          <div className="label">{t("stack.trials")}</div>
          {data.trials.map((tr) => (
            <Link key={tr.id} to={`/subs/${tr.id}`} className="stack-row">
              <span className="stack-row-name">{tr.title}</span>
              <span className="stack-row-said">
                <Money minor={tr.trial_amount} currency={tr.currency_code} /> → <Money minor={tr.paid_amount} currency={tr.currency_code} decimals={false} />
                {" "}{t("stack.trialSince", { date: fmtDay.format(new Date(tr.paid_since * 1000)) })}
              </span>
            </Link>
          ))}
        </div>
      )}

      {data.duplicates.length > 0 && (
        <div className="stack-block">
          <div className="label">{t("stack.dupes")}</div>
          {data.duplicates.map((d) => (
            <div key={d.category_id} className="stack-dupe">
              <span className="stack-row-said">
                {t("stack.dupeQuestion", { names: d.plans.map((p) => p.title).join(" · "), category: d.category_name })}
              </span>
              <span className="stack-dupe-sum">
                <Money minor={d.plans.reduce((s, p) => s + p.monthly, 0)} decimals={false} />{t("stack.perMonthSuffix")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
