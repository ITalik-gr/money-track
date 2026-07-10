import { useGetOverviewQuery } from "../store/api.ts";
import { CashflowChart } from "./CashflowChart.tsx";
import { InfoTip } from "./InfoTip.tsx";

// Огляд: грошовий потік за 6 місяців (DESIGN.md §7 F1, DeliFin R1).
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const fmt0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });

export function CashflowCard() {
  const now = new Date();
  const to = Math.floor(Date.now() / 1000);
  const from = Math.floor(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime() / 1000);
  const { data } = useGetOverviewQuery({ from, to, bucket: "month", currency: 980 });

  const series = data?.series ?? [];
  const rows = series.map((s) => {
    const m = Number(s.bucket.split("-")[1]);
    return { label: MONTHS[m - 1] ?? s.bucket, spend: s.spend / 100, income: s.income / 100 };
  });
  const net = series.reduce((a, s) => a + s.income - s.spend, 0);

  return (
    <div className="card cashflow">
      <div className="cashflow-head">
        <div>
          <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            грошовий потік · 6 міс
            <InfoTip>Надходження мінус витрати щомісяця за останні 6 місяців (зведено в ₴). Сума над стовпцями — чистий підсумок за весь період.</InfoTip>
          </span>
          <div className={`cf-total num-hero ${net < 0 ? "neg" : "pos"}`}>
            {net >= 0 ? "+" : "−"}{fmt0.format(Math.abs(net) / 100)}<span className="cur">₴</span>
          </div>
        </div>
        <div className="legend">
          <span><span className="d" style={{ background: "var(--chart-income)" }} />Надходження</span>
          <span><span className="d" style={{ background: "var(--chart-expense)" }} />Витрати</span>
        </div>
      </div>
      <CashflowChart rows={rows} />
    </div>
  );
}
