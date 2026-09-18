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

/**
 * Enrichment calls triggered by a USER NOTE, per user per day.
 *
 * §ENRICH-GATE lets a note override every skip (see `enrichVerdict`), because a note is the one
 * unambiguous human statement about an operation — and that is exactly what made the change unsafe
 * without this counter. A note is also the cheapest thing to forge into an expensive Sonnet call:
 * §QUICK-ADD writes are token-authenticated but UNATTENDED, so a leaked phone token could post
 * rows with notes all night and nothing would have stopped it. Enrichment records its cost
 * (`cost.ts`) but nothing capped it.
 *
 * 40 rather than 60: this path is Sonnet (the 2026-07-14 exception — a note deserves the model
 * that respects an explanation), so each call costs several times a receipt scan, while a human
 * who writes forty notes in one day is already an unusual day. One constant to change if that
 * turns out to be wrong.
 *
 * ⚠️ Charged when the ASK is about to happen, never per ingested row: the gate answers «skip» for
 * most rows and those must not burn the allowance. Same rule as `countReceiptUpload` — charge on
 * the expensive act, not on the attempt.
 *
 * Fails OPEN, for the same reason: a broken counter must not silently stop recognising operations.
 */
export const DAILY_NOTE_ENRICH = 40;

export async function countNoteEnrich(env: Env): Promise<boolean> {
  const key = `note_enrich_${localYmd(Math.floor(Date.now() / 1000))}`;
  try {
    const used = Number((await getState(env.DB, key)) ?? 0);
    if (used >= DAILY_NOTE_ENRICH) return false;
    await setState(env.DB, key, String(used + 1));
    return true;
  } catch {
    return true;
  }
}
