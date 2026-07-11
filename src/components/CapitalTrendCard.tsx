import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useGetCapitalTrendQuery } from "../store/api.ts";
import { InfoTip } from "./InfoTip.tsx";
import { CHART_ANIM } from "../lib/motion.ts";

// §4 Тренд капіталу: динаміка власних коштів (₴) за 6 місяців (реконструкція від поточного тоталу).
const fmt0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const dLabel = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CapTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{dLabel.format(p.t * 1000)}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />Капітал: {fmt0.format(p.capital_uah)} ₴</div>
    </div>
  );
}

export function CapitalTrendCard() {
  const { data } = useGetCapitalTrendQuery(6);
  const points = data?.points ?? [];
  if (points.length < 2) return null;

  const first = points[0].capital_uah;
  const last = points[points.length - 1].capital_uah;
  const delta = last - first;
  const rows = points.map((p) => ({ ...p, label: dLabel.format(p.t * 1000) }));

  return (
    <div className="card cashflow">
      <div className="cashflow-head">
        <div>
          <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            капітал · 6 міс
            <InfoTip>Власні кошти (без кредитного ліміту) на кожен момент — реконструйовано назад від поточного балансу за історією операцій. Показує, чи росте чи тане «подушка».</InfoTip>
          </span>
          <div className="cf-total num-hero">{fmt0.format(last)}<span className="cur">₴</span></div>
        </div>
        <div className={`cap-delta ${delta >= 0 ? "pos" : "neg"}`}>
          {delta >= 0 ? "▲" : "▼"} {delta >= 0 ? "+" : "−"}{fmt0.format(Math.abs(delta))} ₴
          <span className="cap-delta-sub">за період</span>
        </div>
      </div>
      <div className="chart-wrap" style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 6, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="gCap" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.08} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={28}
              tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis tickLine={false} axisLine={false} width={46} tickCount={4}
              tick={{ fontSize: 11, fill: "var(--muted)" }}
              tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
            <Tooltip content={<CapTooltip />} cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }} />
            <Area type="monotone" dataKey="capital_uah" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" fill="url(#gCap)" dot={false} activeDot={{ r: 3.5 }} {...CHART_ANIM} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
