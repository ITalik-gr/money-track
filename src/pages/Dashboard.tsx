import { Link } from "react-router-dom";
import { getLocale, localeTag } from "../i18n/locale.ts";
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
import { useT } from "../i18n/index.ts";

export function Dashboard() {
  const t = useT();
  const { data: rows = [] } = useGetTransactionsQuery({ limit: 8 });
  // Computed per render so it follows a live language switch (a module-level const would lock
  // the locale at import time).
  const todayLabel = new Intl.DateTimeFormat(localeTag(getLocale()), { day: "numeric", month: "long", year: "numeric" }).format(new Date());

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("dash.greet")}</div>
          <div className="sub">{t("dash.sub")}</div>
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
              <h2>{t("dash.envelopeBudgets")}</h2>
              <Link to="/plan" className="label group-link">{t("common.manage")} →</Link>
            </div>
            <EnvelopeGrid />
          </section>
        </div>

        <aside className="dash-rail">
          <HealthMini />
          <CreditBanner />
          <section>
            <div className="section-head">
              <h2>{t("dash.recent")}</h2>
              <Link to="/tx" className="label">{t("common.all")} →</Link>
            </div>
            <TransactionList rows={rows} />
          </section>
        </aside>
      </div>
    </>
  );
}
