import { useGetOverviewQuery } from "../../store/api.ts";
import { numFmt } from "../../i18n/locale.ts";
import { CashflowChart } from "../stats/CashflowChart.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { monthShort } from "../../lib/format.ts";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// Огляд: грошовий потік за 6 місяців (DESIGN.md §7 F1, DeliFin R1).

export function CashflowCard() {
  const t = useT();
  const fmt0 = numFmt({ maximumFractionDigits: 0 });
  const now = new Date();
  const to = Math.floor(Date.now() / 1000);
  const from = Math.floor(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime() / 1000);
  // Rolled up, not pinned to hryvnia — see the note in `MonthPulse`: a currency here filters the
  // rows instead of choosing a unit, so the six-month cashflow line was missing foreign months.
  const { data, error, refetch } = useGetOverviewQuery({ from, to, bucket: "month", currency: null });

  const series = data?.series ?? [];
  const rows = series.map((s) => {
    const m = Number(s.bucket.split("-")[1]);
    return { label: monthShort(m - 1) ?? s.bucket, spend: s.spend / 100, income: s.income / 100 };
  });
  const net = series.reduce((a, s) => a + s.income - s.spend, 0);

  return (
    <div className="card cashflow">
      <div className="cashflow-head">
        <div>
          <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {t("cf.title")}
            <InfoTip>{t("cf.info")}</InfoTip>
          </span>
          {/* On failure the sum of an empty series is 0, and «+0 ₴» reads as a month that broke
              exactly even — a statement, not an absence. */}
          <div className={`cf-total num-hero ${error ? "" : net < 0 ? "neg" : "pos"}`}>
            {error ? "—" : <>{net >= 0 ? "+" : "−"}{fmt0.format(Math.abs(net) / 100)}<span className="cur">{baseSign()}</span></>}
          </div>
        </div>
        <div className="legend">
          <span><span className="d" style={{ background: "var(--chart-income)" }} />{t("mp.income")}</span>
          <span><span className="d" style={{ background: "var(--chart-expense)" }} />{t("common.expenses")}</span>
        </div>
      </div>
      <ErrorNote error={error} what={t("cf.title")} onRetry={refetch} />
      <CashflowChart rows={rows} />
    </div>
  );
}
