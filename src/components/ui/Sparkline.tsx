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
  const pad = 2;
  const stepX = width / (clean.length - 1);
  const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
  const pts = clean.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = clean[clean.length - 1];
  const first = clean[0];
  const up = last > first * 1.05, down = last < first * 0.95;
  // goodUp: зростання = добре (індекс здоров'я). Інакше (витрати) зростання = погано.
  const trend = up ? (goodUp ? "var(--pos)" : "var(--neg)") : down ? (goodUp ? "var(--neg)" : "var(--pos)") : "var(--muted)";
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
      <circle cx={((clean.length - 1) * stepX).toFixed(1)} cy={y(last).toFixed(1)} r={2} fill={trend} />
    </svg>
  );
}
