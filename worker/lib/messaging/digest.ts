/**
 * §DIGEST-HOUR — WHEN the app is allowed to speak. `notify.ts` decides WHAT is worth saying; this
 * file owns the one question it never asked: at what hour of the reader's day.
 *
 * It exists because the answer used to be a deployment constant. The crons fire at 04:00 and 06:00
 * UTC, so the weekly report, the budget breaches and the model's observations all landed at 07:01
 * Kyiv — four cards waiting before the day they describe had started, which is the worst possible
 * moment for news about yesterday's money. The owner asked for the end of the day, or for a
 * setting; a setting is the same work and answers it for everybody.
 *
 * ⚠️ The preference lives in the user's OWN object (`app_state`), not in the directory row, even
 * though the Worker's fan-out is what reads the clock. Copying it into the directory would make a
 * second place that knows when somebody wants to be spoken to, and the two would drift the first
 * time a write failed halfway. The cost is that the hourly cron wakes every object to ask — three
 * indexed reads for a few dozen users, a rounding error next to one model call.
 *
 * ⚠️ «At or after the hour, once a day» rather than «exactly at the hour»: a cron tick can be
 * missed (a deploy, a Cloudflare hiccup, an object that would not wake), and an equality check
 * would silently drop that whole day's feed. The day marker is what keeps the looser condition
 * from firing twice — it is the same idempotency the `dedup_key` gives each event, one level up.
 */
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { localParts, localYmd } from "../finance/stats.ts";

/** End of the working day: yesterday's money is history by then, and today's is nearly counted. */
export const DEFAULT_DIGEST_HOUR = 20;

const HOUR_KEY = "notify_hour";
/** The Kyiv day whose digest has already run (§APP_TZ — not a UTC one). */
const DAY_KEY = "notify_digest_day";

/** Clamps rather than rejects: an out-of-range hour is a caller's bug, not a reason to go silent. */
export function clampHour(h: unknown): number {
  const n = Math.floor(Number(h));
  if (!Number.isFinite(n)) return DEFAULT_DIGEST_HOUR;
  return Math.min(23, Math.max(0, n));
}

export async function getDigestHour(env: Env): Promise<number> {
  const raw = await getState(env.DB, HOUR_KEY);
  return raw == null ? DEFAULT_DIGEST_HOUR : clampHour(raw);
}

export async function setDigestHour(env: Env, hour: unknown): Promise<number> {
  const h = clampHour(hour);
  await setState(env.DB, HOUR_KEY, String(h));
  return h;
}

/**
 * Is this tick the one that speaks today?
 *
 * Pure decision on purpose — `hour` and `lastDay` come from the caller, so the rule can be tested
 * without a database and read without following two awaits.
 */
export function digestDue(now: number, hour: number, lastDay: string | null): boolean {
  const p = localParts(now);
  if (p.hh < hour) return false;
  return lastDay !== localYmd(now);
}

export async function digestDueNow(env: Env, now: number): Promise<boolean> {
  return digestDue(now, await getDigestHour(env), await getState(env.DB, DAY_KEY));
}

/** Marked AFTER the pass, so a run that threw halfway is retried by the next tick. */
export async function markDigestRan(env: Env, now: number): Promise<void> {
  await setState(env.DB, DAY_KEY, localYmd(now));
}
