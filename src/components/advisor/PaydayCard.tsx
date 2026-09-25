/**
 * §PAYDAY-EFFECT — «after money lands, it goes N× faster». Silent below 3 observed arrivals, and
 * silent when the effect is within ±15% — «you spend about the same» is not worth a card.
 * A rising pace is warned, never scolded: the week after payday is also when bills and a big
 * planned purchase land, and the card says «витрати на розсуд» precisely to leave those out.
 */
import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { useGetPaydayEffectQuery } from "../../store/api.ts";

export function PaydayCard() {
  const t = useT();
  const { data } = useGetPaydayEffectQuery();
  if (!data || data.ratio == null || data.after_week == null || data.typical_week == null) return null;
  if (Math.abs(data.ratio - 1) < 0.15) return null;
  const faster = data.ratio > 1;
  return (
    <div className="card payday-card">
      <div className="ai-title">
        {t("payday.title")}
        <InfoTip>{t("payday.tip")}</InfoTip>
      </div>
      <div className="pd-head">
        <span className={`pd-ratio ${faster ? "warn" : "idle"}`}>×{data.ratio.toFixed(1)}</span>
        <span className="pd-said">{t(faster ? "payday.faster" : "payday.slower", { n: data.events })}</span>
      </div>
      <div className="pd-weeks">
        <span>{t("payday.afterWeek")} <b><Money minor={data.after_week} decimals={false} /></b></span>
        <span>{t("payday.typicalWeek")} <b><Money minor={data.typical_week} decimals={false} /></b></span>
      </div>
    </div>
  );
}
