import { Link } from "react-router-dom";
import { useGetUpcomingSubsQuery } from "../store/api.ts";
import { MerchantLogo } from "./MerchantLogo.tsx";
import { Money } from "./Money.tsx";

// §4 «Скоро спишеться»: планові платежі/підписки у горизонті 30 днів — лого бренду,
// дата, «через N дн». Перетинає межу місяця (на відміну від прогнозу місяця).
const fmtDay = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" });

function whenLabel(days: number): { text: string; urgent: boolean } {
  if (days <= 0) return { text: "сьогодні", urgent: true };
  if (days === 1) return { text: "завтра", urgent: true };
  return { text: `через ${days} дн`, urgent: days <= 3 };
}

export function UpcomingSubs() {
  const { data } = useGetUpcomingSubsQuery(30);
  if (!data || data.items.length === 0) return null;

  return (
    <section>
      <div className="section-head">
        <h2>Скоро спишеться</h2>
        <Link to="/subs" className="label group-link">підписки →</Link>
      </div>
      <div className="card up-subs">
        <div className="up-subs-total">
          <span className="label">за 30 днів</span>
          <span className="num-hero" style={{ fontSize: 22 }}><Money minor={data.total} decimals={false} /></span>
        </div>
        <div className="up-subs-list">
          {data.items.slice(0, 6).map((s) => {
            const w = whenLabel(s.days_until);
            return (
              <div key={s.id} className="up-sub">
                <MerchantLogo merchant={s.title} color={null} fallbackLabel={s.title} />
                <div className="us-mid">
                  <span className="us-name">{s.title}</span>
                  <span className={`us-when ${w.urgent ? "urgent" : ""}`}>{w.text} · {fmtDay.format(s.at * 1000)}</span>
                </div>
                <span className="us-amt"><Money minor={s.amount} decimals={false} /></span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
