import { useGetSummaryQuery } from "../store/api.ts";
import { Money } from "./Money.tsx";

// Кредитний ліміт чорної (§5): власне / борг — ніколи не зливаємо. Стиль проекту.
export function CreditBanner() {
  const { data } = useGetSummaryQuery();
  if (!data?.credit) return null;
  const { limit, own, debt } = data.credit;
  const used = debt; // використано кредиту = борг
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="credit-card">
      <div className="credit-card-head">
        <span className="label">Кредитна картка (чорна)</span>
        <span className="credit-note">кредитні гроші — не твої</span>
      </div>
      <div className="credit-stats">
        <div className="credit-stat">
          <span className="credit-k">власних</span>
          <span className="credit-v pos"><Money minor={Math.max(own, 0)} decimals={false} /></span>
        </div>
        <div className="credit-stat">
          <span className="credit-k">використано кредиту</span>
          <span className="credit-v neg"><Money minor={used} decimals={false} /></span>
        </div>
        <div className="credit-stat">
          <span className="credit-k">ліміт</span>
          <span className="credit-v"><Money minor={limit} decimals={false} /></span>
        </div>
      </div>
      <div className="credit-meter2"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
