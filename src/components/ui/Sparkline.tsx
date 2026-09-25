import { useState } from "react";
import { HoverTip } from "./HoverTip.tsx";
import { dateFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";

const fmtMonth = dateFmt({ month: "long", year: "numeric" });
const fmtShort = dateFmt({ month: "short" });
const monthOf = (ym: string) => new Date(`${ym}-15T12:00:00Z`);

// Міні-тренд 6 міс у рядку списку (категорії/мерчанти). Крихітний SVG-polyline + крапка-кінець,
// колір кінцевої крапки за трендом (зростання витрат = neg, спад = pos). Без осей/підписів.
export function Sparkline({ values, color = "var(--muted)", width = 58, height = 20, goodUp = false, area = false, months, sign }: {
  values: number[]; color?: string; width?: number; height?: number; goodUp?: boolean;
  /**
   * `YYYY-MM` per value, oldest first. Given, the sparkline becomes READABLE: the point under the
   * cursor is marked and a tip says the month, the amount (minor units, with `sign`) and the change
   * against the month before. The owner liked the little line and could not ask it anything — the
   * shape without the numbers made «is this up a lot?» a guess. The LAST month is the running one
   * (`/analytics/spark` ends at the current month), and the tip says so: a half-month compared to a
   * whole one is not a fall.
   */
  months?: string[];
  sign?: string;
  /**
   * Fill the space under the line with a soft wash of `color`.
   *
   * Off by default: at 58×20 in a list row a fill is a grey smudge, and the point there is the
   * direction of the line. It earns its place only when the sparkline is given real height and is
   * the subject of its block rather than a footnote to it.
   */
  area?: boolean;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const clean = values ?? [];
  // A flat line is information once the months can be read (a subscription at one price every
  // month); without them it is a line that says nothing, and stays hidden as before.
  const flat = clean.every((v) => v === clean[0]);
  if (clean.length < 2 || (flat && !months)) {
    return <svg className="spark" width={width} height={height} aria-hidden />;
  }
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const range = max - min || 1;
  /**
   * ⚠️ The x range is INSET by `pad`, like the y range (2026-08-27).
   *
   * `stepX = width / (n − 1)` puts the last point at exactly `x = width`, so half of its 1.4px
   * stroke and half of the 2px end dot fall outside the viewBox and are clipped — every sparkline
   * in the app ended in a half-circle pressed against its own edge. `preserveAspectRatio="none"`
   * makes it worse, because the SVG is stretched to the CSS box and the clip stretches with it.
   */
  const pad = 3;
  const stepX = (width - pad * 2) / (clean.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => flat ? height / 2 : height - pad - ((v - min) / range) * (height - pad * 2);
  const pts = clean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = clean[clean.length - 1];
  const first = clean[0];
  const up = last > first * 1.05, down = last < first * 0.95;
  // goodUp: зростання = добре (індекс здоров'я). Інакше (витрати) зростання = погано.
  const trend = up ? (goodUp ? "var(--pos)" : "var(--neg)") : down ? (goodUp ? "var(--neg)" : "var(--pos)") : "var(--muted)";
  // Closed down to the baseline and back, so the fill has a bottom edge. Built from the same
  // `pts` string as the line — a second point list would drift the moment the padding changes.
  const areaPts = `${x(0).toFixed(1)},${height} ${pts} ${x(clean.length - 1).toFixed(1)},${height}`;
  const svg = (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {area && <polygon points={areaPts} fill={color} opacity={0.12} />}
      {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="spark-guide" />}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
      {hover != null && hover !== clean.length - 1 && <circle cx={x(hover).toFixed(1)} cy={y(clean[hover]).toFixed(1)} r={2.6} fill={color} />}
      <circle cx={x(clean.length - 1).toFixed(1)} cy={y(last).toFixed(1)} r={hover === clean.length - 1 ? 2.8 : 2} fill={trend} />
    </svg>
  );
  if (!months || months.length !== clean.length) return svg;

  const tip = (i: number) => {
    const v = clean[i];
    const prev = i > 0 ? clean[i - 1] : null;
    const running = i === clean.length - 1;
    const pct = prev != null && prev > 0 && !running ? Math.round(((v - prev) / prev) * 100) : null;
    // Tone from the VALUE's meaning (DESIGN §6): more spending is red unless `goodUp`.
    const tone = pct == null || pct === 0 ? "tip-muted" : (pct > 0) === goodUp ? "tip-pos" : "tip-neg";
    return (
      <>
        <div className="tip-lbl">{fmtMonth.format(monthOf(months[i]))}{running ? ` · ${t("spark.running")}` : ""}</div>
        <div className="tip-big">{formatMinor(v, { decimals: false })} {sign}</div>
        {pct != null && (
          <div className={tone}>{pct > 0 ? "+" : pct < 0 ? "−" : ""}{Math.abs(pct)}% {t("spark.vsMonth", { month: fmtShort.format(monthOf(months[i - 1])) })}</div>
        )}
      </>
    );
  };

  return (
    <HoverTip content={hover != null ? tip(hover) : null}>
      <span
        className="spark-hit"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * width;
          setHover(Math.max(0, Math.min(clean.length - 1, Math.round((px - pad) / stepX))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {svg}
      </span>
    </HoverTip>
  );
}
