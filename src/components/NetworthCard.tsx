// Нетворт у часі: активи (ліквідні + інвест) мінус борги, по місяцях.
// На відміну від `CapitalTrendCard` (одна лінія нетто) тут ВИДНО СКЛАД: скільки з нетворту —
// подушка, скільки інвестиції, скільки з'їдає борг. Саме розклад відповідає на «чому нетворт
// не росте» — часто активи ростуть, а борг росте швидше.
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useGetNetworthQuery } from "../store/api.ts";
import { InfoTip } from "./InfoTip.tsx";
import { ErrorNote } from "./ErrorNote.tsx";
import { CHART_ANIM } from "../lib/motion.ts";

const fmt0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const mLabel = new Intl.DateTimeFormat("uk-UA", { month: "short", year: "2-digit" });
const minor = (v: number) => fmt0.format(Math.round(v / 100));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function NwTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />Подушка: {minor(p.cushion)} ₴</div>
      {p.investment > 0 && <div className="r"><span className="d" style={{ background: "var(--pos)" }} />Інвестиції: {minor(p.investment)} ₴</div>}
      {p.debt > 0 && <div className="r"><span className="d" style={{ background: "var(--neg)" }} />Борг: −{minor(p.debt)} ₴</div>}
      <div className="r" style={{ fontWeight: 600 }}>Нетворт: {minor(p.net)} ₴</div>
    </div>
  );
}

export function NetworthCard({ months = 12 }: { months?: number }) {
  const { data, error, refetch } = useGetNetworthQuery(months);
  const points = data?.points ?? [];

  if (error) return <div className="card"><ErrorNote error={error} what="нетворт" onRetry={refetch} /></div>;
  if (points.length < 2) return null;

  const rows = points.map((p) => ({ ...p, label: mLabel.format(p.t * 1000), debtNeg: -p.debt }));
  const first = points[0].net;
  const last = points[points.length - 1].net;
  const delta = last - first;

  return (
    <div className="card cashflow">
      <div className="cashflow-head">
        <div>
          <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            нетворт · {months} міс
            <InfoTip>
              Активи (ліквідна подушка + інвестиції) мінус борги, на кінець кожного місяця.
              Реконструйовано назад від поточних балансів за історією операцій.
              Розклад рахується тим самим правилом, що й «Розбивка коштів» у Пораднику.
            </InfoTip>
          </span>
          <div className="cf-total num-hero">{minor(last)}<span className="cur">₴</span></div>
        </div>
        <div className={`cap-delta ${delta >= 0 ? "pos" : "neg"}`}>
          {delta >= 0 ? "▲" : "▼"} {delta >= 0 ? "+" : "−"}{minor(Math.abs(delta))} ₴
          <span className="cap-delta-sub">за період</span>
        </div>
      </div>

      <div className="chart-wrap" style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} stackOffset="sign">
            <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={24}
              tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis tickLine={false} axisLine={false} width={54} tickCount={5}
              tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(v: number) => fmt0.format(Math.round(v / 100))} />
            <Tooltip content={<NwTooltip />} cursor={{ stroke: "var(--line-strong)" }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
            {/* Борг — від'ємним стеком: він має ТЯГНУТИ ВНИЗ, а не стояти окремою колонкою.
                Так видно, що нетворт-лінія проходить крізь різницю активів і боргу. */}
            <Area type="monotone" dataKey="cushion" name="Подушка" stackId="nw"
              stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.16} isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
            <Area type="monotone" dataKey="investment" name="Інвестиції" stackId="nw"
              stroke="var(--pos)" fill="var(--pos)" fillOpacity={0.16} isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
            <Area type="monotone" dataKey="debtNeg" name="Борг" stackId="nw"
              stroke="var(--neg)" fill="var(--neg)" fillOpacity={0.16} isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
            <Line type="monotone" dataKey="net" name="Нетворт" stroke="var(--ink)" strokeWidth={2} dot={false}
              isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Межі точності озвучуємо прямо на картці. Без них графік читається як точний ряд,
          хоча курси взяті поточні, а ручні рахунки назад плоскі. */}
      {(data?.caveats ?? []).length > 0 && (
        <ul className="nw-caveats">
          {data!.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
    </div>
  );
}
