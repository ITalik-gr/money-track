/**
 * §MOMENTUM — categories that have been moving one way for months, with the run drawn.
 *
 * The Comparison tab answers "how does this period differ from the last one", which cannot tell a
 * bad month from a trend: «Кафе +40%» after a birthday and «Кафе +40%» because eating out has been
 * creeping up since May are the same number and completely different news. Only the second is
 * worth acting on, and only a RUN can distinguish them.
 *
 * The sparkline is the whole point of the block: the claim is about a shape over months, and a
 * badge saying «третій місяць поспіль» with no picture asks to be taken on faith.
 */
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetMomentumQuery } from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { HoverTip } from "../ui/HoverTip.tsx";

/** Small enough to read as a shape rather than a chart, which is what it is. */
const W = 74, H = 22;

function Spark({ series, tone }: { series: number[]; tone: string }) {
  const max = Math.max(...series, 1);
  // The floor is 0, not the minimum: these are amounts of money, and a baseline at the smallest
  // month would turn a 2% wobble into a cliff — the same reason `Y_AXIS` is never hand-sized.
  const pts = series.map((v, i) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * W : W / 2;
    const y = H - (v / max) * (H - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="mo-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke={tone} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Momentum({ sign }: { sign: string }) {
  const t = useT();
  const { data, error, refetch } = useGetMomentumQuery();

  if (error) return <ErrorNote error={error} what={t("stats.momentum.title")} onRetry={refetch} />;
  // Nothing trending is a perfectly good answer about a steady few months, and a card saying so
  // would be a card that is almost always there saying nothing. The block appears when it has news.
  if (!data || !data.rows.length) return null;

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.momentum.title")}</h2>
        <HoverTip content={<>{t("stats.momentum.tip")}</>}>
          <span className="label">{t("common.whatIsThis")}</span>
        </HoverTip>
      </div>
      <div className="card mo-list">
        {data.rows.slice(0, 6).map((r) => {
          const up = r.direction === "up";
          // Rising spending is bad news and falling is good — the opposite of a stock chart, and
          // the reason the tone is chosen from the MEANING rather than from the slope.
          const tone = up ? "var(--neg)" : "var(--pos)";
          return (
            <Link key={r.category_id} to={`/categories/${r.category_id}`} className="mo-row">
              <span className="mo-name">
                <span className="d" style={{ background: r.color ?? "var(--muted)" }} />
                {r.name}
              </span>
              <Spark series={r.series} tone={tone} />
              <span className="mo-run">{t("stats.momentum.run", { n: r.run })}</span>
              <span className={`mo-delta ${up ? "up" : "down"}`}>
                {up ? "+" : "−"}{formatMinor(Math.abs(r.change), { decimals: false })} {sign}
                {r.change_pct != null && (
                  <span className="mo-pct"> ({up ? "+" : "−"}{Math.abs(Math.round(r.change_pct * 100))}%)</span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
