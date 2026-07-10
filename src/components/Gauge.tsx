// Кільце-індикатор (Lefstyle R2): дуга-заповнення + центрований підпис.
export function Gauge({
  ratio, center, sub, tone = "accent",
}: {
  ratio: number;
  center: string;
  sub: string;
  tone?: "accent" | "pos" | "neg" | "warn";
}) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, ratio)) * c;
  return (
    <div className="gauge">
      <svg viewBox="0 0 130 130" width="130" height="130">
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
