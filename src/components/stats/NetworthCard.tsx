// Нетворт у часі: активи (ліквідні + інвест) мінус борги, по місяцях.
// На відміну від `CapitalTrendCard` (одна лінія нетто) тут ВИДНО СКЛАД: скільки з нетворту —
// подушка, скільки інвестиції, скільки з'їдає борг. Саме розклад відповідає на «чому нетворт
// не росте» — часто активи ростуть, а борг росте швидше.
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../../lib/chart.ts";
import { numFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { useGetNetworthQuery } from "../../store/api.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { CHART_ANIM } from "../../lib/motion.ts";
import { monthShort } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";

const fmt0 = numFmt({ maximumFractionDigits: 0 });
const minor = (v: number) => fmt0.format(Math.round(v / 100));

// Підпис місяця рахуємо з `ym` (`YYYY-MM`), а не з `t`. Форматування `t` через Intl у київському
// поясі зсувало кінець місяця на наступний → дубль категорії на осі X із точкою «зараз».
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const i = Number(m) - 1;
  return `${monthShort(i) ?? m} ${y.slice(2)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function NwTooltip(props: any) {
  const t = useT();
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}{p.partial ? t("nw.partialSuffix") : ""}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />{t("nw.cushionLabel")}: {minor(p.cushion)} {baseSign()}</div>
      {p.investment > 0 && <div className="r"><span className="d" style={{ background: "var(--pos)" }} />{t("nw.investmentLabel")}: {minor(p.investment)} {baseSign()}</div>}
      {p.debt > 0 && <div className="r"><span className="d" style={{ background: "var(--neg)" }} />{t("nw.debtLabel")}: −{minor(p.debt)} {baseSign()}</div>}
      <div className="r" style={{ fontWeight: 600 }}>{t("nw.networthLabel")}: {minor(p.net)} {baseSign()}</div>
    </div>
  );
}

export function NetworthCard({ months = 12 }: { months?: number }) {
  const t = useT();
  const { data, error, refetch } = useGetNetworthQuery(months);
  const points = data?.points ?? [];

  if (error) return <div className="card"><ErrorNote error={error} what={t("nw.errorWhat")} onRetry={refetch} /></div>;
  if (points.length < 2) return null;

  // Остання точка — «зараз» (місяць ще не завершений), позначаємо це і в підписі, і в тултіпі:
  // інакше вона читається як повний місяць і виглядає провалом наприкінці ряду.
  const rows = points.map((p, i) => ({
    ...p,
    label: monthLabel(p.ym),
    partial: i === points.length - 1,
    debtNeg: -p.debt,
  }));
  const first = points[0].net;
  const last = points[points.length - 1].net;
  const delta = last - first;

  return (
    <div className="card cashflow nw-card">
      <div className="cashflow-head">
        <div>
          <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {t("nw.monthsLabel", { months })}
            <InfoTip>{t("nw.tip")}</InfoTip>
          </span>
          <div className="cf-total num-hero">{minor(last)}<span className="cur">{baseSign()}</span></div>
        </div>
        <div className={`cap-delta ${delta >= 0 ? "pos" : "neg"}`}>
          {delta >= 0 ? "▲" : "▼"} {delta >= 0 ? "+" : "−"}{minor(Math.abs(delta))} {baseSign()}
          <span className="cap-delta-sub">{t("nw.periodSub")}</span>
        </div>
      </div>

      <div className="chart-wrap" style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* right:14 — щоб остання точка («зараз») не впиралась у край: інакше її курсор/тултіп
              ловився важко, а маркер зрізався. */}
          <ComposedChart data={rows} margin={{ top: 8, right: 14, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }} stackOffset="sign">
            <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
            {/* interval=preserveStartEnd + малий minTickGap: підписи місяців короткі (`лип 26`),
                тож влазять усі; головне — щоб крайні (перший і «зараз») лишались завжди. */}
            <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={6}
              interval="preserveStartEnd" tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis {...Y_AXIS} tickCount={5}
              tickFormatter={(v: number) => fmt0.format(Math.round(v / 100))} />
            <Tooltip content={<NwTooltip />} cursor={{ stroke: "var(--line-strong)" }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
            {/* Борг — від'ємним стеком: він має ТЯГНУТИ ВНИЗ, а не стояти окремою колонкою.
                Так видно, що нетворт-лінія проходить крізь різницю активів і боргу. */}
            <Area type="monotone" dataKey="cushion" name={t("nw.cushionLabel")} stackId="nw"
              stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.16} isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
            <Area type="monotone" dataKey="investment" name={t("nw.investmentLabel")} stackId="nw"
              stroke="var(--pos)" fill="var(--pos)" fillOpacity={0.16} isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
            <Area type="monotone" dataKey="debtNeg" name={t("nw.debtLabel")} stackId="nw"
              stroke="var(--neg)" fill="var(--neg)" fillOpacity={0.16} isAnimationActive={CHART_ANIM.isAnimationActive} animationDuration={CHART_ANIM.animationDuration} />
            {/* Крапка лише на останній точці — «зараз». Ряд закінчується неповним місяцем,
                без маркера це читається як завершений місяць. */}
            <Line type="monotone" dataKey="net" name={t("nw.networthLabel")} stroke="var(--ink)" strokeWidth={2}
              dot={(p: { cx?: number; cy?: number; index?: number; key?: React.Key | null }) =>
                p.index === rows.length - 1 && p.cx != null && p.cy != null
                  ? <circle key={p.key ?? "nw-now"} cx={p.cx} cy={p.cy} r={3.5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
                  : <g key={p.key ?? `nw-${p.index}`} />}
              activeDot={{ r: 4 }}
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
