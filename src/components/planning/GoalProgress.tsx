import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import type { SavingsGoal } from "../../store/api.ts";

/**
 * §P2.1 — the climb toward a goal, drawn.
 *
 * The contribution history was a list of amounts and dates, which answers "what did I put in" but
 * not the question the goal screen is actually for: am I going to make it. The badge on the card
 * (§GOAL-PACE) states the verdict; this SHOWS it, by drawing the required pace as a straight line
 * from the day the goal was opened to its deadline and the real money on top of it. Above the
 * line is ahead, below it is behind — no arithmetic asked of the reader.
 *
 * ⚠️ The pace line uses THE SAME start and deadline as `goalPace` on the server (`created_at`,
 * falling back to 180 days before the deadline). If the two ever disagreed, the chart would
 * contradict the badge sitting directly above it, and the reader would have no way to tell which
 * one is lying.
 *
 * ⚠️ Deliberately not a Recharts chart. It has no axes, no tooltip and no legend — it is a shape
 * read at a glance inside a card, and the library's machinery would cost more than it gives here.
 * The Y axis is fixed at 0 → target, which is what makes the height of the line mean "share of
 * the goal" rather than "share of whatever the biggest contribution happened to be".
 */

const W = 300, H = 72, PAD_T = 6, PAD_B = 14;
const fmtDay = dateFmt({ day: "numeric", month: "short" });

/**
 * §GOAL-CHART — `points` are LEVELS, already resolved by the server for both goal kinds.
 *
 * This component used to receive raw contributions and accumulate them here, which is why a
 * jar-backed goal had no chart at all: a jar has no contributions by definition, its progress IS
 * its account balance. Rather than teach the client a second way to build the same line, the
 * server now hands over one series (`goalProgressSeries`) and this draws it. The jar case is not a
 * branch here — it is just a series whose points happen to come from a balance.
 */
export function GoalProgress({ g, points }: { g: SavingsGoal; points: { at: number; amount: number }[] }) {
  const t = useT();
  if (!points.length || g.target_amount <= 0) return null;

  const now = Date.now() / 1000;
  const byTime = [...points].sort((a, b) => a.at - b.at);

  // The window. Start is the goal's own beginning, so an empty first half is VISIBLE as a flat
  // stretch — that flat stretch is usually the whole explanation for being behind.
  const start = g.created_at ?? (g.deadline != null ? g.deadline - 180 * 86400 : byTime[0]!.at);
  const end = g.deadline ?? Math.max(now, byTime[byTime.length - 1]!.at);
  const span = Math.max(end - start, 1);

  // Y is always 0 → target, except when the goal overshot: clipping the line at the target would
  // hide that money went in beyond it.
  const top = Math.max(g.target_amount, g.current);

  const x = (unix: number) => ((Math.min(Math.max(unix, start), end) - start) / span) * W;
  const y = (v: number) => H - PAD_B - (Math.min(v, top) / top) * (H - PAD_T - PAD_B);

  // A STEP line, for both kinds: savings do not drift upward between events, they jump the day
  // money lands (and a jar balance holds flat between the daily snapshots). A smooth line would
  // draw progress that never happened.
  let running = 0;
  const steps: string[] = [`${x(start).toFixed(1)},${y(0).toFixed(1)}`];
  for (const p of byTime) {
    steps.push(`${x(p.at).toFixed(1)},${y(running).toFixed(1)}`);
    running = p.amount;
    steps.push(`${x(p.at).toFixed(1)},${y(running).toFixed(1)}`);
  }
  // Carry the last level forward to today, so the gap since the most recent movement is a flat run
  // the eye can measure against the pace line.
  steps.push(`${x(Math.min(now, end)).toFixed(1)},${y(running).toFixed(1)}`);

  const hasPace = g.deadline != null;
  const todayX = now >= start && now <= end ? x(now) : null;

  return (
    <div className="goal-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={t("goal.chartAria", { pct: Math.round(g.pace.progress_frac * 100) })}>
        {/* Required pace: opened with nothing, finished exactly on the deadline. */}
        {hasPace && (
          <line x1={x(start)} y1={y(0)} x2={x(end)} y2={y(g.target_amount)}
            className="gch-pace" strokeDasharray="3 3" />
        )}
        {/* The target, so "the top of the chart" is a number and not just the edge of the box. */}
        <line x1={0} y1={y(g.target_amount)} x2={W} y2={y(g.target_amount)} className="gch-target" />
        {todayX != null && <line x1={todayX} y1={PAD_T} x2={todayX} y2={H - PAD_B} className="gch-today" />}
        <polyline points={steps.join(" ")} className="gch-line" fill="none"
          style={{ stroke: g.color ?? "var(--accent)" }} />
      </svg>
      <div className="gch-axis">
        <span>{fmtDay.format(start * 1000)}</span>
        {hasPace && <span>{fmtDay.format(end * 1000)}</span>}
      </div>
    </div>
  );
}
