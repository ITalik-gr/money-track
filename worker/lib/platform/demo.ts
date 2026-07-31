// Demo AI spend limiter (P4.3, PLATFORM.md §11.3).
//
// The demo runs on OUR Anthropic key, so an open "generate" button is an open wallet. Three
// layers cap it, cheapest check first:
//   1. per-session  — a counter in the demo object's own app_state (one sandbox = ~one visitor);
//   2. global daily — an atomic counter in the shared directory db; this is the one that actually
//      saves us, because "many sessions × a small per-session limit" still sums to infinity;
//   3. (outside this file) the model is forced to Haiku and the key is a dedicated
//      `DEMO_ANTHROPIC_KEY` with its own billing limit on Anthropic's side — the last backstop.
//
// A hit throws `DemoAiLimitError`, whose message is shown to the user as-is (via `errText`): the
// point is an honest "the demo's shared AI budget is used up, the examples you see are real"
// rather than a silent failure.
import type { Env } from "../../env.ts";

export const DEMO_SESSION_AI_CAP = 12;      // per sandbox
export const DEMO_GLOBAL_DAILY_AI_CAP = 200; // across ALL sandboxes, per day
// Money caps, added 2026-07-26. Call counts alone CANNOT bound the bill: one chat message with
// the knowledge corpus is ~10k input tokens, so "200 calls" is anywhere between $0.30 and $4
// depending on what is asked. These two are the caps that actually mean something, and they are
// stated in the same unit the Anthropic invoice is.
export const DEMO_GLOBAL_DAILY_USD_CAP = 1.0;
export const DEMO_GLOBAL_MONTHLY_USD_CAP = 10.0;

export function isDemoEnv(env: Env): boolean {
  return (env.USER_ID ?? "").startsWith("demo:");
}

export class DemoAiLimitError extends Error {
  constructor(scope: "session" | "global" | "budget") {
    super(
      scope === "session"
        ? "You've reached this demo sandbox's AI limit. The advisor, reports and insights already on screen are real, pre-generated examples — explore those."
        : "The demo's shared daily AI budget is used up for today. Everything already on screen (advisor, reports, the feed) is a real, pre-generated example — please explore those.",
    );
    this.name = "DemoAiLimitError";
  }
}

// ---- shared counters in the directory db ------------------------------------
// One helper for both the call counter and the spend counter: the atomic
// `INSERT … ON CONFLICT DO UPDATE … RETURNING` is the whole point (concurrent sandboxes must not
// both read the old value and both slip past the ceiling), and duplicating it invites drift.
async function bumpShared(env: Env, key: string, by: number): Promise<number | null> {
  try {
    const row = await env.DIRECTORY
      .prepare(
        `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS REAL) + ?, updated_at = excluded.updated_at
         RETURNING value`,
      )
      .bind(key, String(by), Math.floor(Date.now() / 1000), by)
      .first<{ value: string }>();
    return Number(row?.value ?? "0");
  } catch {
    // shared_state missing (directory not migrated) — caller falls back to the session cap.
    return null;
  }
}

async function readShared(env: Env, key: string): Promise<number> {
  try {
    const row = await env.DIRECTORY.prepare("SELECT value FROM shared_state WHERE key = ?").bind(key).first<{ value: string }>();
    return Number(row?.value ?? "0") || 0;
  } catch {
    return 0;
  }
}

const dayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

/**
 * Book what a demo call actually cost, in USD, against the shared daily+monthly budget.
 * Called from `recordUsage` AFTER the response, because the real cost is only knowable then —
 * `demoAiGate` refuses the NEXT call once the ceiling is crossed. So the budget can overshoot by
 * at most one call, which is the cheapest correct design: pre-charging an estimate would either
 * under-protect (estimate too low) or throttle honest visitors (estimate too high).
 */
/** New sandboxes per day, across everyone. */
export const DEMO_DAILY_NEW_SANDBOXES = 300;

/**
 * Gate the creation of a NEW demo sandbox (`GET /demo`).
 *
 * Every sandbox is a Durable Object seeded with ~350 transactions plus a directory row, created
 * by an unauthenticated GET. Without a ceiling, a loop over that URL is a storage-and-writes bill
 * with no attacker skill required — the AI caps do not help, because none of this touches AI.
 * Returns false when the day's budget is spent; the caller shows the demo-unavailable page.
 *
 * Fails OPEN if `shared_state` is unreachable: a broken counter must not take the demo down.
 */
export async function demoSandboxAllowed(env: Env): Promise<boolean> {
  const n = await bumpShared(env, `demo_new_${dayKey()}`, 1);
  return n == null || n <= DEMO_DAILY_NEW_SANDBOXES;
}

/** New REAL accounts per day, across everyone (open signup, 2026-07-31). */
export const DAILY_NEW_SIGNUPS = 50;

/**
 * Gate the creation of a NEW self-registered account.
 *
 * Same shape as the demo ceiling and for the same reason: with the door open, a Google sign-in
 * becomes a write endpoint — each new account seeds a Durable Object with categories and ~90
 * rules. This bounds a scripted flood.
 *
 * ⚠️ Called ONLY when a row is actually about to be created (`loginWithGoogle`'s `allowSignup`
 * hook), never on a plain sign-in. Bumping it per login attempt would let a handful of returning
 * users burn the day's quota and lock out strangers for no reason.
 *
 * Fails OPEN: a broken counter must not stop people from signing up.
 */
export async function signupAllowed(env: Env): Promise<boolean> {
  const n = await bumpShared(env, `signup_new_${dayKey()}`, 1);
  return n == null || n <= DAILY_NEW_SIGNUPS;
}

export async function demoRecordSpend(env: Env, usd: number): Promise<void> {
  if (!isDemoEnv(env) || !(usd > 0)) return;
  await bumpShared(env, `demo_usd_${dayKey()}`, usd);
  await bumpShared(env, `demo_usd_m_${monthKey()}`, usd);
}

/**
 * Gate one Anthropic call for a demo session. No-op for real users. Throws before spending if a
 * cap is hit. Called at every fetch to Anthropic, so a 6-turn tool conversation counts as 6 — a
 * conservative accounting that errs toward protecting the budget.
 */
export async function demoAiGate(env: Env): Promise<void> {
  if (!isDemoEnv(env)) return;
  const { getState, setState } = await import("../finance/repo.ts");

  // Session cap first — local, no external write, no race (a DO is single-threaded).
  const sessionN = Number((await getState(env.DB, "demo_ai_count")) ?? "0") + 1;
  await setState(env.DB, "demo_ai_count", String(sessionN));
  if (sessionN > DEMO_SESSION_AI_CAP) throw new DemoAiLimitError("session");

  // Money caps BEFORE the call: what previous demo calls actually cost (booked by
  // `demoRecordSpend`). Read-only, so a stale-by-one-call read is fine — the counter is
  // monotonic within the period and one extra Haiku call is cents.
  const [spentToday, spentMonth] = await Promise.all([
    readShared(env, `demo_usd_${dayKey()}`),
    readShared(env, `demo_usd_m_${monthKey()}`),
  ]);
  if (spentToday >= DEMO_GLOBAL_DAILY_USD_CAP || spentMonth >= DEMO_GLOBAL_MONTHLY_USD_CAP) {
    throw new DemoAiLimitError("budget");
  }

  // Global call cap — a second ceiling in a different unit. Keeps a burst of cheap calls (which
  // barely move the USD counter) from hammering the API, and still holds if pricing changes.
  const calls = await bumpShared(env, `demo_ai_${dayKey()}`, 1);
  // `null` = shared_state missing / directory not migrated — session cap already applied above.
  if (calls != null && calls > DEMO_GLOBAL_DAILY_AI_CAP) throw new DemoAiLimitError("global");
}
