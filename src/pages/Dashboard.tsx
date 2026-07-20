import { Link } from "react-router-dom";
import { BalanceCard } from "../components/BalanceCard.tsx";
import { KpiRow } from "../components/KpiRow.tsx";
import { CashflowCard } from "../components/CashflowCard.tsx";
import { CapitalTrendCard } from "../components/CapitalTrendCard.tsx";
import { ForecastCard } from "../components/ForecastCard.tsx";
import { CreditBanner } from "../components/CreditBanner.tsx";
import { HealthMini } from "../components/HealthMini.tsx";
import { EnvelopeGrid } from "../components/EnvelopeGrid.tsx";
import { SafeToSpend } from "../components/SafeToSpend.tsx";
import { MonthPulse } from "../components/MonthPulse.tsx";
import { UpcomingSubs } from "../components/UpcomingSubs.tsx";
import { QuickBar } from "../components/QuickBar.tsx";
import { TransactionList } from "../components/TransactionList.tsx";
import { Icon } from "../components/Icon.tsx";
import { useGetTransactionsQuery } from "../store/api.ts";

const todayLabel = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", year: "numeric" }).format(new Date());

export function Dashboard() {
  const { data: rows = [] } = useGetTransactionsQuery({ limit: 8 });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Вітаю, Віталій</div>
          <div className="sub">Твої гроші, рахунки й бюджети — в одному місці.</div>
        </div>
        <div className="page-head-actions">
          <span className="date-pill"><span className="ico"><Icon name="calendar" size={16} /></span>{todayLabel}</span>
        </div>
      </div>

      <QuickBar />

      {/* Hero band: власні кошти (акцентована картка) + два ключові KPI */}
      <div className="dash-hero">
        <BalanceCard />
        <KpiRow />
      </div>

      {/* Основна аналітика (широка колонка) + рейл швидкого погляду (вузька) */}
      <div className="dash">
        <div className="dash-main">
          <CashflowCard />
          <div className="dash-pair">
            <SafeToSpend />
            <MonthPulse />
          </div>
          <div className="dash-pair">
            <ForecastCard />
            <UpcomingSubs />
          </div>
          <CapitalTrendCard />
          <section>
            <div className="section-head">
              <h2>Бюджети-конверти</h2>
              <Link to="/plan" className="label group-link">керувати →</Link>
            </div>
            <EnvelopeGrid />
          </section>
        </div>

        <aside className="dash-rail">
          <HealthMini />
          <CreditBanner />
          <section>
            <div className="section-head">
              <h2>Останні</h2>
              <Link to="/tx" className="label">усі →</Link>
            </div>
            <TransactionList rows={rows} />
          </section>
        </aside>
      </div>
    </>
  );
}
