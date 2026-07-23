import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { CHART_ANIM } from "../lib/motion.ts";
import { useGetMonthlyHistoryQuery } from "../store/api.ts";
import { HoverTip } from "./HoverTip.tsx";
import { InfoTip } from "./InfoTip.tsx";

const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const monLbl = (m: string) => MONTHS[Number(m.split("-")[1]) - 1] ?? m;
const fmt0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });

type Row = { label: string; spend: number; income: number; net: number; rate: number | null; current: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MhTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const r: Row = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{r.label}{r.current ? " (поточний)" : ""}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-income)" }} />Надходження: {fmt0.format(r.income)} ₴</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-expense)" }} />Витрати: {fmt0.format(r.spend)} ₴</div>
      <div className="r tip-net" style={{ color: r.net >= 0 ? "var(--chart-income)" : "var(--chart-expense)" }}>
        <span className="d" style={{ background: "transparent" }} />Чистий: {r.net >= 0 ? "+" : ""}{fmt0.format(r.net)} ₴
      </div>
    </div>
  );
}

// 6-місячний тренд spend/income/net (канонічний /analytics/monthly-history) + норма
// заощаджень по місяцях. Довгий горизонт, якого не давали періодні вкладки.
export function MonthlyHistory() {
  const { data } = useGetMonthlyHistoryQuery({ months: 6 });
  if (!data || data.months.length === 0) return null;
  const rows: Row[] = data.months.map((m, i) => {
    const spend = m.spend / 100, income = m.income / 100;
    return {
      label: monLbl(m.month), spend, income, net: income - spend,
      rate: m.income > 0 ? Math.round(((m.income - m.spend) / m.income) * 100) : null,
      current: i === data.months.length - 1,
    };
  });
  const hasAny = rows.some((r) => r.spend > 0 || r.income > 0);
  if (!hasAny) return null;
  const rateMax = Math.max(20, ...rows.map((r) => Math.abs(r.rate ?? 0)));

  return (
    <section>
      <div className="section-head">
        <h2>Історія по місяцях</h2>
        <HoverTip content={<>Витрати, надходження й <b>чистий потік</b> (надходження − витрати) за 6 місяців. Канонічні цифри, зведені в ₴. Останній місяць — поточний, ще не завершився.</>}>
          <span className="label">6 міс · що це?</span>
        </HoverTip>
      </div>
      <div className="card mh-card">
        <div className="legend" style={{ justifyContent: "flex-end", padding: "0 2px 8px" }}>
          <span><span className="d" style={{ background: "var(--chart-income)" }} />Надходження</span>
          <span><span className="d" style={{ background: "var(--chart-expense)" }} />Витрати</span>
          <span><span className="d" style={{ background: "var(--accent)" }} />Чистий</span>
        </div>
        <div className="chart-wrap" style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 6, left: -14, bottom: 0 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <YAxis tickLine={false} axisLine={false} width={46} tickCount={4}
                tick={{ fontSize: 11, fill: "var(--muted)" }}
                tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <Tooltip content={<MhTooltip />} cursor={{ fill: "var(--surface-2)", opacity: 0.5 }} />
              <Bar dataKey="income" fill="var(--chart-income)" radius={[3, 3, 0, 0]} maxBarSize={22} {...CHART_ANIM} />
              <Bar dataKey="spend" fill="var(--chart-expense)" radius={[3, 3, 0, 0]} maxBarSize={22} {...CHART_ANIM} />
              <Line type="monotone" dataKey="net" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" dot={{ r: 2.5, fill: "var(--accent)" }} activeDot={{ r: 4 }} {...CHART_ANIM} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="mh-rates">
          <div className="mh-rates-head">
            <span className="label">Норма заощаджень по місяцях</span>
            <InfoTip>Скільки з надходжень місяця лишилось після витрат: (надходження − витрати) ÷ надходження. Від'ємне — витратив більше, ніж отримав.</InfoTip>
          </div>
          <div className="mh-rate-bars">
            {rows.map((r, i) => (
              <HoverTip key={i} content={<><div className="tip-lbl">{r.label}{r.current ? " (поточний)" : ""}</div><div className="r">Норма: {r.rate != null ? `${r.rate}%` : "—"}</div></>}>
                <div className="mh-rate-col">
                  <div className="mh-rate-track">
                    {r.rate != null && r.rate >= 0 && <span className="mh-rate-fill pos" style={{ height: `${Math.min(100, (r.rate / rateMax) * 50)}%` }} />}
                    {r.rate != null && r.rate < 0 && <span className="mh-rate-fill neg" style={{ height: `${Math.min(100, (-r.rate / rateMax) * 50)}%` }} />}
                  </div>
                  <span className={`mh-rate-val ${r.rate == null ? "muted" : r.rate >= 0 ? "pos" : "neg"}`}>{r.rate != null ? `${r.rate}%` : "—"}</span>
                  <span className="mh-rate-lbl">{r.label}</span>
                </div>
              </HoverTip>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
