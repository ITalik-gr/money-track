import { catColor, CAT_FALLBACK } from "../../lib/theme.ts";
import { wholePcts } from "../../../shared/pct.ts";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { formatMinor } from "../../lib/format.ts";
import type { Overview } from "../../store/api.ts";
import { useT, translate } from "../../i18n/index.ts";
import { getLocale } from "../../i18n/locale.ts";

const isSecondary = (name: string | null) => /переказ|зняття/i.test(name ?? "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DonutTip(props: any, sign: string) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{d.name}</div>
      <div className="r"><span className="d" style={{ background: catColor(d.payload.color) }} />{formatMinor(d.value, { decimals: false })} {sign}</div>
      <div className="r tip-muted">{d.payload.pct}% {translate(getLocale(), "sd.spendWord")}</div>
    </div>
  );
}

// Донат розподілу витрат по категоріях (топ-7 + «інші»). Пончик = миттєва частка, якої
// горизонтальні бари не дають так наочно. Перекази/зняття виключено (як в основному розподілі).
export function SpendDonut({ rows, sign }: { rows: Overview["byCategory"]; sign: string }) {
  const t = useT();
  const primary = rows.filter((r) => !isSecondary(r.category_name) && r.spent > 0);
  if (primary.length < 2) return null;
  const top = primary.slice(0, 7).map((r, i) => ({ name: r.category_name ?? t("sd.noCategoryFallback"), value: r.spent, color: catColor(r.color ?? CAT_FALLBACK[i % CAT_FALLBACK.length]) }));
  const restSum = primary.slice(7).reduce((s, r) => s + r.spent, 0);
  if (restSum > 0) top.push({ name: t("sd.othersLabel"), value: restSum, color: "var(--c-mist)" });
  const total = top.reduce((s, d) => s + d.value, 0);
  if (!total) return null;
  // §PCT-SUM: one rule for the whole set, so the legend adds up to 100 (it could read 99 or 101).
  const pcts = wholePcts(top.map((d) => d.value));
  const withPct = top.map((d, i) => ({ ...d, pct: pcts[i] }));

  return (
    <div className="card spend-donut-card">
      <div className="report-donut">
        <ResponsiveContainer width="100%" height={210}>
          <PieChart>
            <Pie data={withPct} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={58} outerRadius={88} paddingAngle={1.5} strokeWidth={0} {...CHART_ANIM}>
              {withPct.map((d, i) => <Cell key={i} fill={catColor(d.color)} />)}
            </Pie>
            <Tooltip content={(p) => DonutTip(p, sign)} />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <span className="dc-val">{formatMinor(total, { decimals: false })} {sign}</span>
          <span className="dc-lbl">{t("sd.spendWord")}</span>
        </div>
      </div>
      <div className="donut-legend">
        {withPct.map((d, i) => (
          <span key={i} className="dl-item">
            <span className="d" style={{ background: catColor(d.color) }} />
            <span className="dl-name">{d.name}</span>
            {/* Money AND share — the owner: «щоб ще показувало скільки відсотково … а не тіки гривні». */}
            <span className="dl-amt">{formatMinor(d.value, { decimals: false })} {sign}</span>
            <span className="dl-pct">{d.pct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
