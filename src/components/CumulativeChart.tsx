import { AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// §1: кумулятивний потік (running balance) — накопичена чиста різниця (надходження − витрати)
// по днях періоду. Показує траєкторію: пішов період у плюс чи в мінус і коли.
// proj — прогноз-лінія (пунктир) на решту періоду за поточним середнім темпом.
export interface CumRow { label: string; cum: number | null; proj?: number | null }

const fmt0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CumTooltip({ active, payload, label, sign }: any) {
  if (!active || !payload?.length) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cum = payload.find((e: any) => e.dataKey === "cum" && e.value != null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proj = payload.find((e: any) => e.dataKey === "proj" && e.value != null);
  const e = cum ?? proj;
  if (!e) return null;
  const v = e.value as number;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{label}{proj && !cum ? " · прогноз" : ""}</div>
      <div className="r" style={{ color: v >= 0 ? "var(--chart-income)" : "var(--chart-expense)" }}>
        {proj && !cum ? "Прогноз" : "Накопичено"}: {v >= 0 ? "+" : "−"}{fmt0.format(Math.abs(v))} {sign}
      </div>
    </div>
  );
}

export function CumulativeChart({ rows, sign, height = 220 }: { rows: CumRow[]; sign: string; height?: number }) {
  if (rows.length < 2) return <div className="empty">Замало даних для графіка</div>;
  const actual = rows.filter((r) => r.cum != null).map((r) => r.cum as number);
  const last = actual[actual.length - 1] ?? 0;
  const stroke = last >= 0 ? "var(--chart-income)" : "var(--chart-expense)";
  const hasProj = rows.some((r) => r.proj != null);
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 6, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="gCum" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.2} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 4" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={20}
            tick={{ fontSize: 12, fill: "var(--muted)" }} />
          <YAxis tickLine={false} axisLine={false} width={46}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
          <ReferenceLine y={0} stroke="var(--line-strong)" strokeWidth={1} />
          <Tooltip content={<CumTooltip sign={sign} />} cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }} />
          <Area type="monotone" dataKey="cum" stroke={stroke} strokeWidth={2.4} fill="url(#gCum)" dot={false} activeDot={{ r: 4 }} connectNulls={false} />
          {hasProj && (
            <Line type="monotone" dataKey="proj" stroke={stroke} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 3 }} connectNulls opacity={0.7} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
