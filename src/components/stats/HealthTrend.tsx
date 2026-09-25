import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { HealthComponent, HealthParts, HealthTrendPoint } from "../../../shared/api/analytics.ts";
import { useT } from "../../i18n/index.ts";
import { CHART_ANIM } from "../../lib/motion.ts";

/** `2026-09-10` → `10.09`. The trend axis needs a day, not a year it already knows. */
export function shortDay(day: string): string {
  const [, m, d] = day.split("-");
  return m && d ? `${d}.${m}` : day;
}

const PART_KEYS = ["runway", "savings", "debt", "stability"] as const;
type PartKey = (typeof PART_KEYS)[number];
const ptsOf = (p: HealthParts, k: PartKey) => p[`pts_${k}` as const];
const BAND_KEY = { good: "hic.band.good", ok: "hic.band.ok", risk: "hic.band.risk" } as const;
const bandOf = (s: number) => (s >= 70 ? "good" : s >= 45 ? "ok" : "risk") as keyof typeof BAND_KEY;

interface Row { day: string; label: string; score: number; parts: HealthParts | null; prev: HealthParts | null }

/**
 * §HEALTH-TREND — the index over time, and what each day was MADE of.
 *
 * The owner: «в індексі здоров'я є графік, але не можна на нього ховерити і бачити яка тоді була
 * оцінка». The sparkline answered «is it going up», and nothing else. A score on its own teaches
 * nothing — «68» is only useful next to «stability −6 since the day before», because that names the
 * part to look at. So the tooltip leads with the score and its band, then lists the four parts'
 * points, each with its move against the PREVIOUS recorded day, and names the biggest mover.
 *
 * ⚠️ Days recorded before migration 0055 have no parts; the tooltip says so rather than drawing
 * four zeros. ⚠️ The y-axis is fixed 0..100: the index has a scale, and auto-fitting it to the data
 * turned a 3-point wobble into a cliff (DESIGN §6 «axis floor is 0 for trend sparklines»).
 */
export function HealthTrend({ trend, components }: { trend: HealthTrendPoint[]; components: HealthComponent[] }) {
  const t = useT();
  const labelOf = new Map(components.map((c) => [c.key, c.label]));
  const rows: Row[] = trend.map((p, i) => ({
    day: p.day, label: shortDay(p.day), score: p.score, parts: p.parts,
    prev: i > 0 ? trend[i - 1].parts : null,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function Tip(props: any) {
    const { active, payload } = props;
    if (!active || !payload?.length) return null;
    const r: Row = payload[0].payload;
    const moves = r.parts && r.prev
      ? PART_KEYS.map((k) => ({ k, d: (ptsOf(r.parts!, k) ?? 0) - (ptsOf(r.prev!, k) ?? 0) })).filter((m) => m.d !== 0)
      : [];
    const top = moves.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    return (
      <div className="chart-tip ht-tip">
        <div className="tip-lbl">{r.label}</div>
        <div className="r ht-tip-score">
          <b>{r.score}</b> <span className="ht-tip-of">{t("hic.of100")}</span> · {t(BAND_KEY[bandOf(r.score)])}
        </div>
        {r.parts ? (
          <div className="ht-tip-parts">
            {PART_KEYS.map((k) => {
              const v = ptsOf(r.parts!, k);
              const was = r.prev ? ptsOf(r.prev, k) : null;
              const d = v != null && was != null ? v - was : 0;
              return (
                <div className="r" key={k}>
                  <span className="ht-tip-name">{labelOf.get(k) ?? k}</span>
                  <span className="ht-tip-v">{v == null ? "—" : v}</span>
                  {d !== 0 && <span className={d > 0 ? "ht-tip-up" : "ht-tip-down"}>{d > 0 ? "+" : "−"}{Math.abs(d)}</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ht-tip-note">{t("hic.tipNoParts")}</div>
        )}
        {top && (
          <div className="ht-tip-note">
            {t("hic.tipMoved", { part: (labelOf.get(top.k) ?? top.k).toLowerCase(), value: `${top.d > 0 ? "+" : "−"}${Math.abs(top.d)}` })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ht-chart">
      <ResponsiveContainer width="100%" height={96}>
        <AreaChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="label" hide />
          <YAxis domain={[0, 100]} hide />
          {/* Escapes the plot vertically: the chart is 96px tall and the tooltip is taller, so a
              clamped tooltip would cover the very line it describes. */}
          <Tooltip content={<Tip />} cursor={{ stroke: "var(--line-strong)" }} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 5 }} />
          <Area
            type="monotone" dataKey="score" stroke="var(--accent)" strokeWidth={1.6}
            fill="var(--accent)" fillOpacity={0.12} dot={false}
            activeDot={{ r: 3.5, stroke: "var(--surface)", strokeWidth: 2 }}
            {...CHART_ANIM}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
