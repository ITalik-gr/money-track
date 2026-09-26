import { catColor } from "../../lib/theme.ts";
import { AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../../lib/chart.ts";
import { numFmt } from "../../i18n/locale.ts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { useT } from "../../i18n/index.ts";
import type { CumPoint } from "./StatsTrends.tsx";

// §1: кумулятивний потік (running balance) — накопичена чиста різниця (надходження − витрати)
// по днях періоду. Показує траєкторію: пішов період у плюс чи в мінус і коли.
// proj — прогноз-лінія (пунктир) на решту періоду (§CASH-PROJ, перераховується на кожен запит).
//
// ⚠️ The tooltip says what MOVED the line that day, not only where it is (owner: «тіки накопичено
// пише, не зрозуміло що це»). A running total alone asks the reader to subtract two hover
// positions to learn what happened on one day. So: an actual day = spent · received · the day's
// net, then the running total; a projected day = each planned charge BY NAME, the expected ordinary
// spend, any expected income, then the projected total.

const fmt0 = numFmt({ maximumFractionDigits: 0 });
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt0.format(Math.abs(v))}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CumTooltip({ active, payload, sign }: any) {
  const t = useT();
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as CumPoint | undefined;
  if (!row) return null;
  const projected = row.cum == null;
  const total = projected ? row.proj : row.cum;
  if (total == null) return null;
  const tone = (v: number) => (v > 0 ? "tip-pos" : v < 0 ? "tip-neg" : "tip-muted");

  if (!projected) {
    const net = (row.income ?? 0) - (row.spend ?? 0);
    return (
      <div className="chart-tip cum-tip">
        <div className="tip-lbl">{row.title}</div>
        <div className="tip-kv"><span>{t("cum.spent")}</span><span>{row.spend ? `−${fmt0.format(row.spend)}` : "0"} {sign}</span></div>
        {!!row.income && <div className="tip-kv"><span>{t("cum.received")}</span><span className="tip-pos">+{fmt0.format(row.income)} {sign}</span></div>}
        <div className="tip-kv"><span>{t("cum.dayNet")}</span><span className={tone(net)}>{signed(net)} {sign}</span></div>
        <div className="tip-sec tip-kv"><span>{t("cum.sinceStart")}</span><span className={`tip-big ${tone(total)}`}>{signed(total)} {sign}</span></div>
      </div>
    );
  }

  const plans = row.plans ?? [];
  const incomes = row.incomes ?? [];
  return (
    <div className="chart-tip cum-tip">
      <div className="tip-lbl">{row.title} · {t("cum.forecastWord")}</div>
      {plans.map((p, i) => (
        <div key={i} className="tip-kv"><span>{p.title}</span><span>−{fmt0.format(p.amount)} {sign}</span></div>
      ))}
      {incomes.map((p, i) => (
        <div key={`i${i}`} className="tip-kv"><span>{p.title}</span><span className="tip-pos">+{fmt0.format(p.amount)} {sign}</span></div>
      ))}
      {row.payday && !!row.expIncome && (
        <div className="tip-kv"><span>{t("cum.payday")}</span><span className="tip-pos">+{fmt0.format(row.expIncome)} {sign}</span></div>
      )}
      {!!row.ordinary && (
        <div className="tip-kv"><span>{t("cum.ordinary")}</span><span>≈ −{fmt0.format(row.ordinary)} {sign}</span></div>
      )}
      <div className="tip-sec tip-kv"><span>{t("cum.projTotal")}</span><span className={`tip-big ${tone(total)}`}>{signed(total)} {sign}</span></div>
    </div>
  );
}

export function CumulativeChart({ rows, sign, height = 220 }: { rows: CumPoint[]; sign: string; height?: number }) {
  const t = useT();
  if (rows.length < 2) return <div className="empty">{t("cum.emptyData")}</div>;
  const actualRows = rows.filter((r) => r.cum != null);
  const last = actualRows[actualRows.length - 1]?.cum ?? 0;
  const stroke = last >= 0 ? "var(--chart-income)" : "var(--chart-expense)";
  const hasProj = rows.some((r) => r.cum == null && r.proj != null);
  const end = hasProj ? rows[rows.length - 1].proj ?? null : null;
  const todayLabel = hasProj ? actualRows[actualRows.length - 1]?.label : undefined;
  return (
    <>
      {/* The two numbers the line is FOR, in words above it: where the period stands now and where
          it is heading. Before, both had to be found by hovering the two ends of the line. */}
      <div className="cum-summary">
        <span>{t("cum.now")} <b className={last >= 0 ? "pos" : "neg"}>{signed(last)} {sign}</b></span>
        {end != null && (
          <span>{t("cum.endOfPeriod")} <b className={end >= 0 ? "pos" : "neg"}>{signed(end)} {sign}</b></span>
        )}
      </div>
      <div className="chart-wrap" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 6, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }}>
            <defs>
              <linearGradient id="gCum" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={catColor(stroke)} stopOpacity={0.08} />
                <stop offset="100%" stopColor={catColor(stroke)} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={24}
              tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis {...Y_AXIS} tickCount={4}
              tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
            <ReferenceLine y={0} stroke="var(--line-strong)" strokeWidth={1} />
            {/* Where the facts end and the forecast begins. */}
            {todayLabel && <ReferenceLine x={todayLabel} stroke="var(--line-strong)" strokeDasharray="2 3" />}
            <Tooltip content={<CumTooltip sign={sign} />} cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }} />
            <Area type="monotone" dataKey="cum" stroke={catColor(stroke)} strokeWidth={2} strokeLinecap="round" fill="url(#gCum)" dot={false} activeDot={{ r: 3.5 }} connectNulls={false} {...CHART_ANIM} />
            {hasProj && (
              <Line type="monotone" dataKey="proj" stroke={catColor(stroke)} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 3 }} connectNulls opacity={0.7} {...CHART_ANIM} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
