// Кільце-індикатор (Lefstyle R2): дуга-заповнення + центрований підпис.
export function Gauge({
  ratio, center, sub, tone = "accent", size = 130,
}: {
  ratio: number;
  center: string;
  sub: string;
  tone?: "accent" | "pos" | "neg" | "warn";
  /** Діаметр у px. Геометрія лишається у viewBox 130 — масштабується цілком, без переверстки. */
  size?: number;
}) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, ratio)) * c;
  return (
    <div className={`gauge ${size < 110 ? "sm" : ""}`}>
      <svg viewBox="0 0 130 130" width={size} height={size}>
        <circle cx="65" cy="65" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
        <circle
          cx="65" cy="65" r={r} fill="none" stroke={`var(--${tone})`} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`} transform="rotate(-90 65 65)"
        />
      </svg>
      <div className="gauge-center">
        <div className="gauge-val num-hero">{center}</div>
        <div className="label" style={{ marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}
