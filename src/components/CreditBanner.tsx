import { useGetSummaryQuery } from "../store/api.ts";
import { Money } from "./Money.tsx";
import { useT } from "../i18n/index.ts";

// Кредитний ліміт чорної (§5): власне / борг — ніколи не зливаємо. Стиль проекту.
export function CreditBanner() {
  const t = useT();
  const { data } = useGetSummaryQuery();
  if (!data?.credit) return null;
  const { limit, own, debt } = data.credit;
  const used = debt; // використано кредиту = борг
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="credit-card">
      <div className="credit-card-head">
        <span className="label">{t("cb.title")}</span>
        <span className="credit-note">{t("cb.note")}</span>
      </div>
      <div className="credit-stats">
        <div className="credit-stat">
          <span className="credit-k">{t("cb.own")}</span>
          <span className="credit-v pos"><Money minor={Math.max(own, 0)} decimals={false} /></span>
        </div>
        <div className="credit-stat">
          <span className="credit-k">{t("cb.used")}</span>
          <span className="credit-v neg"><Money minor={used} decimals={false} /></span>
        </div>
        <div className="credit-stat">
          <span className="credit-k">{t("cb.limit")}</span>
          <span className="credit-v"><Money minor={limit} decimals={false} /></span>
        </div>
      </div>
      <div className="credit-meter2"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
