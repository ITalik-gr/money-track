import { useGetForecastQuery } from "../store/api.ts";
import { Money } from "./Money.tsx";
import { formatMinor } from "../lib/format.ts";

// Прогноз кінця місяця (§7): скільки витратимо за поточним темпом + майбутні планові
// платежі. Сильна фіча для runway — видно ще до кінця місяця, чи вкладаєшся.
export function ForecastCard() {
  const { data: f } = useGetForecastQuery();
  if (!f) return null;

  const paceRatio = f.projectedSpend > 0 ? Math.min(f.spend / f.projectedSpend, 1) : 0;
  const netTone = f.projectedNet >= 0 ? "pos" : "neg";

  return (
    <section>
      <div className="section-head">
        <h2>Прогноз місяця</h2>
        <span className="label">лишилось {f.daysRemaining} дн</span>
      </div>
      <div className="card forecast-card">
        <div className="fc-main">
          <div>
            <div className="label">прогноз витрат до кінця місяця</div>
            <div className="num-hero" style={{ fontSize: 34 }}><Money minor={f.projectedSpend} decimals={false} /></div>
          </div>
          <div className="fc-net">
            <div className="label">прогноз-нетто</div>
            <div className={`num-hero ${netTone}`} style={{ fontSize: 22 }}>
              {f.projectedNet >= 0 ? "+" : ""}{formatMinor(f.projectedNet, { decimals: false })} ₴
            </div>
          </div>
        </div>

        <div className="fc-bar">
          <div className="fc-fill" style={{ width: `${paceRatio * 100}%` }} />
        </div>
        <div className="fc-legend">
          <span>витрачено <b><Money minor={f.spend} decimals={false} /></b></span>
          <span className="muted">темп {formatMinor(f.pace, { decimals: false })} ₴/день</span>
        </div>

        {f.upcomingPlanned > 0 && (
          <div className="fc-upcoming">
            <div className="label">
              ще спишеться цього місяця · <Money minor={f.upcomingPlanned} decimals={false} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
