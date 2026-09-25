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
import { useGetSubStackQuery } from "../../store/api.ts";

const fmtMonth = dateFmt({ month: "short" });
const fmtDay = dateFmt({ day: "numeric", month: "short" });
const monthLabel = (ym: string) => fmtMonth.format(new Date(`${ym}-15T12:00:00Z`));

export function SubsStackCard() {
  const t = useT();
  const { data } = useGetSubStackQuery();
  if (!data) return null;
  const hasHistory = data.paid.length >= 2;
  if (!hasHistory && !data.duplicates.length && !data.trials.length) return null;
  const max = Math.max(1, ...data.paid.map((p) => p.paid));

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

      {hasHistory && (
        <div className="stack-cols" role="img" aria-label={t("stack.chartLabel")}>
          {data.paid.map((p) => (
            <div className="stack-col" key={p.ym} title={`${monthLabel(p.ym)}`}>
              <span className="stack-col-track">
                <i style={{ height: `${p.paid > 0 ? Math.max(4, (p.paid / max) * 100) : 0}%` }} />
              </span>
              <span className="stack-col-m">{monthLabel(p.ym)}</span>
            </div>
          ))}
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
