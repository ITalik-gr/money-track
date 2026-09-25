/**
 * `drafts-health` — the financial health index as news: record today's score, and say so when it
 * has dropped.
 *
 * Split out of `notify.ts` on 2026-09-25 (lint C3: that file sits at its size exception and needed
 * a line it did not have). The seam is real: both functions here are about `health_history`, and
 * nothing else in the feed reads or writes that table.
 *
 * §HEALTH-TREND — why the score is now recorded by the daily run and not only by the page. The
 * trend and `health_drop` both read `health_history`, and that table was written ONLY when the
 * health card was opened. A person who did not open it for a week had no trend for that week, and
 * the «your index dropped» card could never fire for the very people who were not looking — the
 * ones it exists for. The upsert is per Kyiv day, so the page and the run write the same row.
 */
import type { Env } from "../../env.ts";
import { localYmd } from "../finance/stats.ts";
import { financeHealth, healthParts } from "../finance/health.ts";
import { recordHealthScore } from "../../repo/health.ts";
import type { Draft } from "./notify.ts";

// The same one-liner every sibling drafter keeps: a dedup key needs a Kyiv calendar day.
const isoDay = (unix: number) => localYmd(unix);

/** Compute today's index and upsert it (with its parts) into `health_history` — unless it is provisional. */
export async function recordTodayHealth(env: Env, now: number): Promise<void> {
  const h = await financeHealth(env);
  // A provisional score is not history: recording «100» for an empty account would draw a cliff
  // down to the first real score, and `draftHealthDrop` would announce a drop that never happened.
  if (h.insufficient) return;
  await recordHealthScore(env.DB, isoDay(now), h.score, now, healthParts(h));
}

/** Індекс фінздоровʼя помітно просів проти минулого тижня (дані з health_history). */
export async function draftHealthDrop(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    "SELECT day, score FROM health_history WHERE ts >= ? ORDER BY ts DESC LIMIT 30",
  ).bind(now - 30 * 86400).all<{ day: string; score: number }>();
  const hist = rows.results ?? [];
  if (hist.length < 2) return [];

  const latest = hist[0];
  // Порівнюємо з найсвіжішим записом, старшим за 5 днів — щоб не ловити добовий шум.
  const cutoff = isoDay(now - 5 * 86400);
  const past = hist.find((h) => h.day <= cutoff);
  if (!past) return [];
  const drop = past.score - latest.score;
  if (drop < 8) return [];

  return [{
    kind: "health_drop",
    tkey: "health_drop",
    tparams: { drop, pastScore: past.score, pastDay: past.day, latestScore: latest.score },
    severity: "warn",
    entity_type: null, entity_id: null,
    dedup_key: `health_drop:${latest.day}`,
  }];
}
