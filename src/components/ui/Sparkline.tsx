// Міні-тренд 6 міс у рядку списку (категорії/мерчанти). Крихітний SVG-polyline + крапка-кінець,
// колір кінцевої крапки за трендом (зростання витрат = neg, спад = pos). Без осей/підписів.
export function Sparkline({ values, color = "var(--muted)", width = 58, height = 20, goodUp = false }: {
  values: number[]; color?: string; width?: number; height?: number; goodUp?: boolean;
}) {
  const clean = values ?? [];
  if (clean.length < 2 || clean.every((v) => v === clean[0])) {
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
  const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
  const pts = clean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = clean[clean.length - 1];
  const first = clean[0];
  const up = last > first * 1.05, down = last < first * 0.95;
  // goodUp: зростання = добре (індекс здоров'я). Інакше (витрати) зростання = погано.
  const trend = up ? (goodUp ? "var(--pos)" : "var(--neg)") : down ? (goodUp ? "var(--neg)" : "var(--pos)") : "var(--muted)";
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
      <circle cx={x(clean.length - 1).toFixed(1)} cy={y(last).toFixed(1)} r={2} fill={trend} />
    </svg>
  );
}
