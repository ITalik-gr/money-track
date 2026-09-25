import { useGetForecastQuery, useGetOverviewQuery, useGetCashProjectionQuery } from "../../store/api.ts";
import { CumulativeChart } from "../stats/CumulativeChart.tsx";
import { toCumulative } from "../stats/StatsTrends.tsx";
import { Money } from "../ui/Money.tsx";
import { formatMinor } from "../../lib/format.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { HoverTip, TipBody } from "../ui/HoverTip.tsx";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// Прогноз кінця місяця (§7): скільки витратимо за поточним темпом + майбутні планові
// платежі. Сильна фіча для runway — видно ще до кінця місяця, чи вкладаєшся.
export function ForecastCard() {
  const t = useT();
  const { data: f } = useGetForecastQuery();
  // §CASH-PROJ on the dashboard (UI_PASS S11): the month as a line — facts to today, then the
  // named plans and the usual spending day by day — with the same hover as Statistics. The window
  // comes from the forecast's OWN month bounds (Kyiv, server-side), so the two cannot disagree
  // about where the month ends. Explicit bounds, not `preset: "month"`: under the rolling period
  // mode that preset is the last 30 days, and a rolling window cannot meet a month-end forecast.
  const { data: month } = useGetOverviewQuery(
    { from: f?.monthStart ?? 0, to: f?.now ?? 0, bucket: "day", currency: null }, { skip: !f },
  );
  const until = f ? f.monthStart + f.daysInMonth * 86400 - 1 : 0;
  const { data: projection } = useGetCashProjectionQuery(
    { to: f?.now ?? 0, until, currency: null }, { skip: !f || f.daysRemaining <= 0 },
  );
  if (!f) return null;

  const paceRatio = f.projectedSpend > 0 ? Math.min(f.spend / f.projectedSpend, 1) : 0;
  const netTone = f.projectedNet >= 0 ? "pos" : "neg";

  return (
    <section>
      <div className="section-head">
        <h2>{t("fc.title")}</h2>
        <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {t("fc.daysLeft", { days: f.daysRemaining })}
          <InfoTip>{t("fc.info")}</InfoTip>
        </span>
      </div>
      <div className="card forecast-card">
        <div className="fc-main">
          <div>
            <div className="label">{t("fc.projSpend")}</div>
            <div className="num-hero" style={{ fontSize: 34 }}><Money minor={f.projectedSpend} decimals={false} /></div>
            {f.projectedLow != null && f.projectedHigh != null && f.projectedHigh > f.projectedLow && (
              <div className="fc-range">≈ {formatMinor(f.projectedLow, { decimals: false })}–{formatMinor(f.projectedHigh, { decimals: false })} {baseSign()}</div>
            )}
          </div>
          <div className="fc-net">
            <div className="label">{t("fc.projNet")}</div>
            <div className={`num-hero ${netTone}`} style={{ fontSize: 22 }}>
              {f.projectedNet >= 0 ? "+" : ""}{formatMinor(f.projectedNet, { decimals: false })} {baseSign()}
            </div>
          </div>
        </div>

        <HoverTip content={<TipBody label={t("common.spent")} value={<Money minor={f.spend} decimals={false} />}
          sub={t("tip.spentOf", { pct: Math.round(paceRatio * 100), of: formatMinor(f.projectedSpend, { decimals: false }) + " " + baseSign() })} />}>
          <div className="fc-bar">
            <div className="fc-fill" style={{ width: `${paceRatio * 100}%` }} />
          </div>
        </HoverTip>
        <div className="fc-legend">
          <span>{t("common.spent")} <b><Money minor={f.spend} decimals={false} /></b></span>
          <span className="muted">{t("fc.pace", { pace: formatMinor(f.pace, { decimals: false }) })}</span>
        </div>

        {month && month.series.length >= 2 && (
          <div className="fc-flow">
            <div className="label">{t("fc.flow")}</div>
            <CumulativeChart rows={toCumulative(month.series, projection)} sign={baseSign()} height={180} />
          </div>
        )}

        {f.upcomingPlanned > 0 && (
          <div className="fc-upcoming">
            <div className="label">
              {t("fc.stillDue")} · <Money minor={f.upcomingPlanned} decimals={false} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
