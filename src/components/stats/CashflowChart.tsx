import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../../lib/chart.ts";
import { getLocale, numFmt } from "../../i18n/locale.ts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { translate } from "../../i18n/index.ts";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// Спільний dual-line графік: витрати + надходження (DESIGN.md §7 F1).
export interface CfRow { label: string; spend: number; income: number }

const fmt0 = numFmt({ maximumFractionDigits: 0 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CfTooltip(props: any) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inc = payload.find((e: any) => e.dataKey === "income")?.value ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exp = payload.find((e: any) => e.dataKey === "spend")?.value ?? 0;
  const net = inc - exp;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{label}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-income)" }} />{translate(getLocale(), "mp.income")}: {fmt0.format(inc)} {baseSign()}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-expense)" }} />{translate(getLocale(), "common.expenses")}: {fmt0.format(exp)} {baseSign()}</div>
      <div className="r tip-net" style={{ color: net >= 0 ? "var(--chart-income)" : "var(--chart-expense)" }}>
        <span className="d" style={{ background: "transparent" }} />{translate(getLocale(), "common.balance")}: {net >= 0 ? "+" : ""}{fmt0.format(net)} {baseSign()}
      </div>
    </div>
  );
}

export function CashflowChart({ rows, height = 230 }: { rows: CfRow[]; height?: number }) {
  const t = useT();
  if (rows.length === 0) return <div className="empty">{t("chart.noData")}</div>;
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* DESIGN.md §10.3: система-тони (cobalt-витрата дом. + green-дохід тихий),
            без пунктир-сітки, 2px round-лінії без крапок, одна делікатна area. */}
        <AreaChart data={rows} margin={{ top: 8, right: 6, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }}>
          <defs>
            <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-expense)" stopOpacity={0.08} />
              <stop offset="100%" stopColor="var(--chart-expense)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={24}
            tick={{ fontSize: 11, fill: "var(--muted)" }} />
          <YAxis {...Y_AXIS} tickCount={4}
           
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
          <Tooltip content={<CfTooltip />} cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }} />
          {/* дохід — тиха лінія без заливки */}
          <Area type="monotone" dataKey="income" stroke="var(--chart-income)" strokeWidth={2} strokeLinecap="round" fill="none" dot={false} activeDot={{ r: 3.5 }} {...CHART_ANIM} />
          {/* витрата — домінантна: делікатна area + лінія */}
          <Area type="monotone" dataKey="spend" stroke="var(--chart-expense)" strokeWidth={2} strokeLinecap="round" fill="url(#gExp)" dot={false} activeDot={{ r: 3.5 }} {...CHART_ANIM} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
