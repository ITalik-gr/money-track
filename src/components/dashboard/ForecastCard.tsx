import { useGetForecastQuery } from "../store/api.ts";
import { Money } from "./Money.tsx";
import { formatMinor } from "../lib/format.ts";
import { InfoTip } from "./InfoTip.tsx";
import { useT } from "../i18n/index.ts";

// Прогноз кінця місяця (§7): скільки витратимо за поточним темпом + майбутні планові
// платежі. Сильна фіча для runway — видно ще до кінця місяця, чи вкладаєшся.
export function ForecastCard() {
  const t = useT();
  const { data: f } = useGetForecastQuery();
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
              <div className="fc-range">≈ {formatMinor(f.projectedLow, { decimals: false })}–{formatMinor(f.projectedHigh, { decimals: false })} ₴</div>
            )}
          </div>
          <div className="fc-net">
            <div className="label">{t("fc.projNet")}</div>
            <div className={`num-hero ${netTone}`} style={{ fontSize: 22 }}>
              {f.projectedNet >= 0 ? "+" : ""}{formatMinor(f.projectedNet, { decimals: false })} ₴
            </div>
          </div>
        </div>

        <div className="fc-bar">
          <div className="fc-fill" style={{ width: `${paceRatio * 100}%` }} />
        </div>
        <div className="fc-legend">
          <span>{t("common.spent")} <b><Money minor={f.spend} decimals={false} /></b></span>
          <span className="muted">{t("fc.pace", { pace: formatMinor(f.pace, { decimals: false }) })}</span>
        </div>

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
