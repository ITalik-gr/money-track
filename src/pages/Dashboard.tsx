import { Link } from "react-router-dom";
import { dateFmt } from "../i18n/locale.ts";
import { BalanceCard } from "../components/dashboard/BalanceCard.tsx";
import { KpiRow } from "../components/dashboard/KpiRow.tsx";
import { CashflowCard } from "../components/dashboard/CashflowCard.tsx";
import { CapitalTrendCard } from "../components/dashboard/CapitalTrendCard.tsx";
import { ForecastCard } from "../components/dashboard/ForecastCard.tsx";
import { CreditBanner } from "../components/dashboard/CreditBanner.tsx";
import { HealthMini } from "../components/dashboard/HealthMini.tsx";
import { EnvelopeGrid } from "../components/planning/EnvelopeGrid.tsx";
import { SafeToSpend } from "../components/dashboard/SafeToSpend.tsx";
import { MonthPulse } from "../components/dashboard/MonthPulse.tsx";
import { UpcomingSubs } from "../components/dashboard/UpcomingSubs.tsx";
import { QuickBar } from "../components/dashboard/QuickBar.tsx";
import { SetupNudge } from "../components/dashboard/SetupNudge.tsx";
import { PrefsHint } from "../components/dashboard/PrefsHint.tsx";
import { TransactionList } from "../components/transactions/TransactionList.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { useGetMeQuery, useGetTransactionsQuery } from "../store/api.ts";
import { useT } from "../i18n/index.ts";

export function Dashboard() {
  const t = useT();
  const { data: rows = [] } = useGetTransactionsQuery({ limit: 8 });
  const { data: me } = useGetMeQuery();
  // The greeting used to hardcode the owner's name, so every demo visitor was welcomed as
  // "Vitalii". Take the first name from the signed-in account; a demo sandbox has no real
  // identity, so it gets the plain greeting.
  const firstName = me?.demo ? null : (me?.user?.name ?? "").trim().split(/\s+/)[0] || null;
  // Computed per render so it follows a live language switch (a module-level const would lock
  // the locale at import time).
  const todayLabel = dateFmt({ day: "numeric", month: "long", year: "numeric" }).format(new Date());

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{firstName ? t("dash.greetNamed", { name: firstName }) : t("dash.greet")}</div>
          <div className="sub">{t("dash.sub")}</div>
        </div>
        <div className="page-head-actions">
          <span className="date-pill"><span className="ico"><Icon name="calendar" size={16} /></span>{todayLabel}</span>
        </div>
      </div>

      <SetupNudge />
      <PrefsHint />

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
