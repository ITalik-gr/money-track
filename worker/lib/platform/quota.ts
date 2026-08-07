// Per-user daily ceilings on the things a signed-in user can make US store or spend.
//
// Distinct from `demo.ts`, which bounds what STRANGERS can do to the shared deployment. This file
// bounds a REAL account, and it exists because registration is open (2026-07-31): "signed in" is
// no longer a synonym for "someone the owner knows".
//
// The counter lives in the user's OWN `app_state`, not in the shared directory. That is the whole
// reason this is cheap: the Durable Object is already awake and already holds a local SQLite, so a
// quota check is one local read instead of a write to a database shared by everyone.
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { localYmd } from "../finance/stats.ts";

/**
 * Receipt images per user per day.
 *
 * Sized to be invisible to a real person and obvious for a script: a heavy user photographs a
 * handful of receipts a day, and 60 is a week of that in one sitting. The number is not the
 * defence against a determined attacker — the account can always be disabled — it is the thing
 * that keeps an accident, a loop or a bored visitor from filling a bucket nobody is watching.
 */
export const DAILY_RECEIPTS = 60;

/**
 * Count one receipt upload against today's allowance. Returns how many are left AFTER this one,
 * or `null` when the ceiling is already spent.
 *
 * ⚠️ The day key is the KYIV day (§APP_TZ), like every other date key in this project. With
 * `toISOString()` the allowance would roll over at 03:00 local time, and a user uploading late in
 * the evening would be counted against tomorrow — the same class of bug that made notifications
 * de-duplicate against the wrong day.
 *
 * ⚠️ Bumped only when an upload is actually ACCEPTED (after the size check), never per attempt.
 * A counter that charges for rejected requests lets a stream of 6 MB files — which we refuse
 * anyway — burn a real user's quota. Same rule as `allowSignup`: charge on creation, not on try.
 *
 * Fails OPEN if `app_state` cannot be read: a broken counter must not stop someone from filing
 * an expense.
 */
export async function countReceiptUpload(env: Env): Promise<{ ok: boolean; left: number }> {
  const key = `receipts_${localYmd(Math.floor(Date.now() / 1000))}`;
  try {
    const used = Number((await getState(env.DB, key)) ?? 0);
    if (used >= DAILY_RECEIPTS) return { ok: false, left: 0 };
    await setState(env.DB, key, String(used + 1));
    return { ok: true, left: DAILY_RECEIPTS - used - 1 };
  } catch {
    return { ok: true, left: DAILY_RECEIPTS };
  }
}
