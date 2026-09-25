// `health_history` — the financial health index over time (§HEALTH-TREND). Split out of
// `repo/analytics.ts` on 2026-09-25, when `worker/repo` came under lint C3 with that file at 1006
// lines: these are the only queries on this table, and they have one reader each (the page, the
// daily run, the trend and the AI's 30-day change).
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { HealthParts, HealthTrendPoint } from "../../shared/api/analytics.ts";

/**
 * Records today's health score, one row per day.
 *
 * §APP_TZ: `day` MUST be a Kyiv-local key. The notification feed's `draftHealthDrop` compares
 * these rows to spot a decline "over 5 days", so a UTC key would put an evening view and a
 * late-night view of the same day into two different rows and measure the drop on a shifted grid.
 */
export async function recordHealthScore(
  db: AppDb, day: string, score: number, ts: number, parts: HealthParts | null = null,
): Promise<void> {
  // §HEALTH-TREND (migration 0055): the parts ride along, so a past day can say what it was made of.
  await db.prepare(
    `INSERT INTO health_history (day, score, ts, pts_runway, pts_savings, pts_debt, pts_stability)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET score = excluded.score, ts = excluded.ts,
       pts_runway = excluded.pts_runway, pts_savings = excluded.pts_savings,
       pts_debt = excluded.pts_debt, pts_stability = excluded.pts_stability`,
  ).bind(day, score, ts, parts?.pts_runway ?? null, parts?.pts_savings ?? null, parts?.pts_debt ?? null, parts?.pts_stability ?? null).run();
}

export async function healthTrend(
  db: AppDb, since: string,
): Promise<HealthTrendPoint[]> {
  const res = await db.prepare(
    `SELECT day, score, pts_runway, pts_savings, pts_debt, pts_stability
     FROM health_history WHERE day >= ? ORDER BY day`,
  ).bind(since).all<{ day: string; score: number; pts_runway: number | null; pts_savings: number | null; pts_debt: number | null; pts_stability: number | null }>();
  return (res.results ?? []).map((r) => ({
    day: r.day, score: r.score,
    // A row from before 0055 has no parts at all — say so with null, not with four zeros.
    parts: r.pts_runway == null && r.pts_savings == null && r.pts_debt == null && r.pts_stability == null
      ? null
      : { pts_runway: r.pts_runway, pts_savings: r.pts_savings, pts_debt: r.pts_debt, pts_stability: r.pts_stability },
  }));
}
