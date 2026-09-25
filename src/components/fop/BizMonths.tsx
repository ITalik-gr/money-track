import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../../lib/chart.ts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { numFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { monthShort } from "../../lib/format.ts";
import { hryvniaSign } from "../../../shared/currency.ts";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import type { BusinessOverview } from "../../store/api.ts";

const fmt0 = numFmt({ maximumFractionDigits: 0 });
const monLbl = (m: string) => monthShort(Number(m.split("-")[1]) - 1) ?? m;

/**
 * The business month by month — the resolution a quarter grid cannot give.
 *
 * WHY IT EARNS A PLACE NEXT TO THE QUARTERS. A quarter is the unit the STATE asks about; it is not
 * the unit a business is run in. Six quarterly bars cannot show a month that went into the red, a
 * client who left in April, or the two-month ramp after a new contract — all of which the owner
 * acts on, and none of which the tax calendar cares about. The quarters stay because the tax does;
 * this exists because the business does (§BIZ-SPLIT).
 *
 * ⚠️ §TAX-UAH — hryvnia, like everything else on this page, so the sign comes from
 * `hryvniaSign()` and never from `baseSign()`.
 *
 * ⚠️ The net LINE is the point, not decoration: income and cost bars side by side make a bad month
 * something the reader has to compute by eye, and a month whose costs quietly passed its income is
 * exactly the one nobody notices in a bar pair.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MonthTip(props: any) {
  const t = useT();
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const r = payload[0].payload as { label: string; income: number; costs: number; net: number };
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{r.label}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-income)" }} />{t("fop.income")}: {fmt0.format(r.income)} {hryvniaSign()}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-expense)" }} />{t("fop.costs")}: {fmt0.format(r.costs)} {hryvniaSign()}</div>
      <div className="r" style={{ color: r.net >= 0 ? "var(--chart-income)" : "var(--chart-expense)" }}>
        <span className="d" style={{ background: "transparent" }} />
        {t("fop.net")}: {r.net >= 0 ? "+" : ""}{fmt0.format(r.net)} {hryvniaSign()}
      </div>
    </div>
  );
}

export function BizMonths({ data }: { data: BusinessOverview }) {
  const t = useT();
  const rows = data.months.map((m) => ({
    label: monLbl(m.ym),
    income: m.income / 100,
    costs: m.costs / 100,
    net: (m.income - m.costs) / 100,
  }));
  const hasAny = rows.some((r) => r.income > 0 || r.costs > 0);

  return (
    <div className="card">
      <div className="section-head"><h3>{t("fop.months")}</h3></div>
      {!hasAny ? (
        <EmptyCard icon="stats" title={t("fop.noMonths")} hint={t("fop.noMonthsHint")} />
      ) : (
        <div className="fop-chart">
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: Y_AXIS_LEFT_MARGIN }}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <YAxis {...Y_AXIS} tickFormatter={(v: number) => fmt0.format(v)} />
              <Tooltip content={<MonthTip />} cursor={{ fill: "var(--surface-2)" }} />
              <Bar dataKey="income" fill="var(--chart-income)" radius={[4, 4, 0, 0]} {...CHART_ANIM} />
              <Bar dataKey="costs" fill="var(--chart-expense)" radius={[4, 4, 0, 0]} {...CHART_ANIM} />
              <Line type="monotone" dataKey="net" stroke="var(--accent)" strokeWidth={2} dot={false} {...CHART_ANIM} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
