import { useGetOverviewQuery, useGetPeriodModeQuery } from "../store/api.ts";
import { Icon } from "./Icon.tsx";
import { formatMinor, currencySign } from "../lib/format.ts";

function pct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

function KpiTile({
  title, kind, valueMinor, prevMinor, deltaPct, prevLabel,
}: {
  title: string;
  kind: "spend" | "income";
  valueMinor: number;
  prevMinor: number;
  deltaPct: number | null;
  prevLabel: string;
}) {
  // spend: зростання — погано (черв.); income: зростання — добре (зел.)
  const goodWhenUp = kind === "income";
  const up = (deltaPct ?? 0) >= 0;
  const good = up === goodWhenUp;

  return (
    <div className="card kpi-tile">
      <div className="kpi-head">
        <span className={`kpi-ic ${kind}`}>
          <Icon name="arrowUpRight" size={17} />
        </span>
        <span className="kpi-title">{title}</span>
      </div>
      <div className="kpi-num num-hero">
        {formatMinor(valueMinor, { decimals: false })}
        <span className="cur">{currencySign(980)}</span>
      </div>
      <div className="kpi-foot">
        {deltaPct !== null && (
          <span className={`delta ${good ? "up" : "down"}`}>
            {up ? "↑" : "↓"} {Math.abs(deltaPct).toFixed(1)}%
          </span>
        )}
        <span>{prevLabel}: {formatMinor(prevMinor, { decimals: false })} {currencySign(980)}</span>
      </div>
    </div>
  );
}

export function KpiRow() {
  // Preset «month» + режим period_mode → ті самі межі, що й Статистика (числа збігаються).
  // Валюта не передається → зведено в ₴ (USD-витрати/доходи враховані).
  const { data: pm } = useGetPeriodModeQuery();
  const { data } = useGetOverviewQuery({ preset: "month" });
  const rolling = pm?.mode === "rolling";

  const spend = data?.summary.spend ?? 0;
  const income = data?.summary.income ?? 0;
  const prevSpend = data?.prev.spend ?? 0;
  const prevIncome = data?.prev.income ?? 0;
  const prevLabel = rolling ? "попередні 30 дн" : "минулого міс.";

  return (
    <div className="kpi-row">
      <KpiTile title={rolling ? "Витрачено (30 дн)" : "Витрачено за місяць"} kind="spend" valueMinor={spend} prevMinor={prevSpend} deltaPct={pct(spend, prevSpend)} prevLabel={prevLabel} />
      <KpiTile title={rolling ? "Надходження (30 дн)" : "Надходження за місяць"} kind="income" valueMinor={income} prevMinor={prevIncome} deltaPct={pct(income, prevIncome)} prevLabel={prevLabel} />
    </div>
  );
}
