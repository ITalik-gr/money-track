import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { numFmt } from "../../i18n/locale.ts";
import type { ParsedChart } from "../../lib/chart-block.ts";
import { catColor } from "../../lib/theme.ts";

// Theme tokens only (§THEME), so a chart in a saved answer follows a later theme switch.
const COLORS = ["var(--accent)", "var(--pos)", "var(--warn)", "var(--neg)", "var(--ink-2)", "var(--muted)"];
const fmt = (n: number) => numFmt({ maximumFractionDigits: 2 }).format(n);
const short = (n: number) => numFmt({ notation: "compact", maximumFractionDigits: 1 }).format(n);
const TIP = { background: "var(--tip)", border: "1px solid var(--tip-line)", borderRadius: 8, color: "var(--tip-ink)", fontSize: 12 };
const TICK = { fontSize: 11, fill: "var(--muted)" };

export default function ChatChart({ chart }: { chart: ParsedChart }) {
  const data = chart.rows.map((r) => ({ label: r.label, ...Object.fromEntries(chart.series.map((_, i) => [`s${i}`, r.values[i]])) }));
  const tip = <Tooltip contentStyle={TIP} itemStyle={{ color: "var(--tip-ink)" }} labelStyle={{ color: "var(--tip-muted)" }}
    formatter={(v, name) => [fmt(Number(v)), chart.series[Number(String(name).slice(1))] || ""]} />;
  const axes = [
    <CartesianGrid key="g" vertical={false} stroke="var(--line)" />,
    <XAxis key="x" dataKey="label" tick={TICK} tickLine={false} axisLine={false} minTickGap={12} />,
    <YAxis key="y" tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={short} />,
  ];
  const margin = { top: 6, right: 6, bottom: 0, left: 0 };
  const legend = chart.type === "donut"
    ? chart.rows.map((r, i) => ({ name: `${r.label} · ${fmt(r.values[0])}`, color: COLORS[i % COLORS.length] }))
    : chart.series.length > 1 ? chart.series.map((name, i) => ({ name, color: COLORS[i] })) : [];

  return (
    <div className="md-plot">
      {chart.title && <div className="md-chart-title">{chart.title}</div>}
      <div className="md-plot-area">
        <ResponsiveContainer width="100%" height="100%">
          {chart.type === "donut" ? (
            <PieChart>
              {tip}
              <Pie data={data} dataKey="s0" nameKey="label" innerRadius="58%" outerRadius="88%" paddingAngle={2} stroke="none">
                {data.map((d, i) => <Cell key={d.label} fill={catColor(COLORS[i % COLORS.length])} />)}
              </Pie>
            </PieChart>
          ) : chart.type === "line" ? (
            <LineChart data={data} margin={margin}>
              {axes}{tip}
              {chart.series.map((_, i) => <Line key={i} dataKey={`s${i}`} stroke={catColor(COLORS[i])} strokeWidth={2} dot={data.length <= 12} isAnimationActive={false} />)}
            </LineChart>
          ) : chart.type === "area" ? (
            <AreaChart data={data} margin={margin}>
              {axes}{tip}
              {chart.series.map((_, i) => <Area key={i} dataKey={`s${i}`} stroke={catColor(COLORS[i])} fill={catColor(COLORS[i])} fillOpacity={0.14} strokeWidth={2} isAnimationActive={false} />)}
            </AreaChart>
          ) : (
            <BarChart data={data} margin={margin}>
              {axes}{tip}
              {chart.series.map((_, i) => <Bar key={i} dataKey={`s${i}`} fill={catColor(COLORS[i])} radius={[4, 4, 0, 0]} isAnimationActive={false} />)}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {legend.length > 0 && (
        <div className="md-plot-key">
          {legend.map((l) => <span key={l.name}><span className="md-plot-dot" style={{ background: catColor(l.color) }} />{l.name}</span>)}
        </div>
      )}
    </div>
  );
}
