import { useGetOverviewQuery } from "../../store/api.ts";
import { numFmt } from "../../i18n/locale.ts";
import { CashflowChart } from "../stats/CashflowChart.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { monthShort } from "../../lib/format.ts";
import { useT } from "../../i18n/index.ts";

// Огляд: грошовий потік за 6 місяців (DESIGN.md §7 F1, DeliFin R1).

export function CashflowCard() {
  const t = useT();
  const fmt0 = numFmt({ maximumFractionDigits: 0 });
  const now = new Date();
  const to = Math.floor(Date.now() / 1000);
  const from = Math.floor(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime() / 1000);
  const { data } = useGetOverviewQuery({ from, to, bucket: "month", currency: 980 });

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
          <div className={`cf-total num-hero ${net < 0 ? "neg" : "pos"}`}>
            {net >= 0 ? "+" : "−"}{fmt0.format(Math.abs(net) / 100)}<span className="cur">₴</span>
          </div>
        </div>
        <div className="legend">
          <span><span className="d" style={{ background: "var(--chart-income)" }} />{t("mp.income")}</span>
          <span><span className="d" style={{ background: "var(--chart-expense)" }} />{t("common.expenses")}</span>
        </div>
      </div>
      <CashflowChart rows={rows} />
    </div>
  );
}
