import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { formatMinor } from "../../lib/format.ts";
import type { Overview } from "../../store/api.ts";
import { useT, translate } from "../../i18n/index.ts";
import { getLocale } from "../../i18n/locale.ts";

const FALLBACK = ["#1f6e4c", "#2e6be6", "#7a3e9d", "#c9871a", "#b23a2e", "#127c86", "#6b7a74", "#8a5a2b"];
const isSecondary = (name: string | null) => /переказ|зняття/i.test(name ?? "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DonutTip(props: any, sign: string) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{d.name}</div>
      <div className="r"><span className="d" style={{ background: d.payload.color }} />{formatMinor(d.value, { decimals: false })} {sign}</div>
      <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{d.payload.pct}% {translate(getLocale(), "sd.spendWord")}</div>
    </div>
  );
}

// Донат розподілу витрат по категоріях (топ-7 + «інші»). Пончик = миттєва частка, якої
// горизонтальні бари не дають так наочно. Перекази/зняття виключено (як в основному розподілі).
export function SpendDonut({ rows, sign }: { rows: Overview["byCategory"]; sign: string }) {
  const t = useT();
  const primary = rows.filter((r) => !isSecondary(r.category_name) && r.spent > 0);
  if (primary.length < 2) return null;
  const top = primary.slice(0, 7).map((r, i) => ({ name: r.category_name ?? t("sd.noCategoryFallback"), value: r.spent, color: r.color ?? FALLBACK[i % FALLBACK.length] }));
  const restSum = primary.slice(7).reduce((s, r) => s + r.spent, 0);
  if (restSum > 0) top.push({ name: t("sd.othersLabel"), value: restSum, color: "#9aa5a0" });
  const total = top.reduce((s, d) => s + d.value, 0);
  if (!total) return null;
  const withPct = top.map((d) => ({ ...d, pct: Math.round((d.value / total) * 100) }));

  return (
    <div className="card spend-donut-card">
      <div className="report-donut">
        <ResponsiveContainer width="100%" height={210}>
          <PieChart>
            <Pie data={withPct} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={58} outerRadius={88} paddingAngle={1.5} strokeWidth={0} {...CHART_ANIM}>
              {withPct.map((d, i) => <Cell key={i} fill={d.color} />)}
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
            <span className="d" style={{ background: d.color }} />
            <span className="dl-name">{d.name}</span>
            <span className="dl-pct">{d.pct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
