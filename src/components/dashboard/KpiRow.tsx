import { useGetOverviewQuery, useGetPeriodModeQuery } from "../../store/api.ts";
import { Icon } from "../ui/Icon.tsx";
import { formatMinor } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";
import { useCountUp } from "../../lib/useCountUp.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { useT } from "../../i18n/index.ts";

function pct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

function KpiTile({
  title, kind, valueMinor, prevMinor, deltaPct, prevLabel, info, unknown,
}: {
  title: string;
  kind: "spend" | "income";
  valueMinor: number;
  prevMinor: number;
  deltaPct: number | null;
  prevLabel: string;
  info: string;
  /** The request failed. A tile that prints 0 ₴ says «ти нічого не витратив», which is a claim. */
  unknown?: boolean;
}) {
  // spend: зростання — погано (черв.); income: зростання — добре (зел.)
  const goodWhenUp = kind === "income";
  const up = (deltaPct ?? 0) >= 0;
  const good = up === goodWhenUp;
  const animVal = useCountUp(valueMinor); // §10.4

  return (
    <div className="card kpi-tile">
      <div className="kpi-head-row">
        <div className="kpi-head">
          <span className={`kpi-ic ${kind}`}>
            <Icon name="arrowUpRight" size={17} />
          </span>
          <span className="kpi-title">{title}</span>
        </div>
        <span className="kpi-info"><InfoTip>{info}</InfoTip></span>
      </div>
      <div className="kpi-num num-hero">
        {unknown ? "—" : (
          <>
            {formatMinor(Math.round(animVal), { decimals: false })}
            <span className="cur">{baseSign()}</span>
          </>
        )}
      </div>
      <div className="kpi-foot">
        {!unknown && deltaPct !== null && (
          <span className={`delta ${good ? "up" : "down"}`}>
            {up ? "↑" : "↓"} {Math.abs(deltaPct).toFixed(1)}%
          </span>
        )}
        <span>{unknown ? "" : `${prevLabel}: ${formatMinor(prevMinor, { decimals: false })} ${baseSign()}`}</span>
      </div>
    </div>
  );
}

export function KpiRow() {
  const t = useT();
  // Preset «month» + режим period_mode → ті самі межі, що й Статистика (числа збігаються).
  // No currency is passed → rolled up into the reader's base, foreign spending included.
  const { data: pm } = useGetPeriodModeQuery();
  const { data, error, refetch } = useGetOverviewQuery({ preset: "month" });
  const rolling = pm?.mode === "rolling";

  const spend = data?.summary.spend ?? 0;
  const income = data?.summary.income ?? 0;
  const prevSpend = data?.prev.spend ?? 0;
  const prevIncome = data?.prev.income ?? 0;
  const prevLabel = rolling ? t("kpi.prev30") : t("kpi.prevMonth");

  // §Обробка помилок: `data?.x ?? 0` on a failed request renders «0 ₴ витрачено» — the same
  // defect as `BalanceCard`, one row below it. The tiles keep their shape (the row must not
  // collapse) and say they have no answer.
  const failed = !!error;

  return (
    <>
      <div className="kpi-row">
        <KpiTile title={rolling ? t("kpi.spent30") : t("kpi.spentMonth")} kind="spend" valueMinor={spend} prevMinor={prevSpend} deltaPct={pct(spend, prevSpend)} prevLabel={prevLabel}
          info={t("kpi.spendInfo")} unknown={failed} />
        <KpiTile title={rolling ? t("kpi.income30") : t("kpi.incomeMonth")} kind="income" valueMinor={income} prevMinor={prevIncome} deltaPct={pct(income, prevIncome)} prevLabel={prevLabel}
          info={t("kpi.incomeInfo")} unknown={failed} />
      </div>
      <ErrorNote error={error} what={t("kpi.spendInfo")} onRetry={refetch} />
    </>
  );
}
