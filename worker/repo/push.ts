// Web-push subscriptions, and the notifications still owed to them.
// See `worker/repo/README.md`, and `migrations/0039_push.sql` for what is deliberately not stored.
import type { AppDb } from "../lib/platform/db-shim.ts";

export interface PushSub {
  endpoint: string;
  created_at: number;
  last_ok_at: number | null;
  fail_count: number;
}

/** Consecutive soft failures before a subscription is treated as dead. */
export const PUSH_MAX_FAILS = 5;

export async function list(db: AppDb): Promise<PushSub[]> {
  const r = await db.prepare(
    "SELECT endpoint, created_at, last_ok_at, fail_count FROM push_subscriptions ORDER BY created_at",
  ).all<PushSub>();
  return r.results ?? [];
}

export async function count(db: AppDb): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * `OR IGNORE`, not an upsert: re-subscribing the same browser must not reset `created_at` or wipe
 * the failure history. The browser re-subscribes on every service-worker update.
 */
export async function add(db: AppDb, endpoint: string, at: number): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO push_subscriptions (endpoint, created_at) VALUES (?, ?)",
  ).bind(endpoint, at).run();
}

export async function remove(db: AppDb, endpoint: string): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
}

export async function markOk(db: AppDb, endpoint: string, at: number): Promise<void> {
  await db.prepare(
    "UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?",
  ).bind(at, endpoint).run();
}

/** A failure that was not definitive. The row dies only after `PUSH_MAX_FAILS` of them. */
export async function markFail(db: AppDb, endpoint: string): Promise<void> {
  await db.prepare(
    "UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?",
  ).bind(endpoint).run();
  await db.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND fail_count >= ?",
  ).bind(endpoint, PUSH_MAX_FAILS).run();
}

/**
 * Whether anything is worth waking a browser for.
 *
 * Same bar as the Telegram push — `warn` and `urgent` only. A notification that can wait for the
 * next time someone opens the app must never ring a phone: a channel that fires for everything is
 * a channel people turn off, and then it is not there for the one that mattered.
 */
export async function pendingCount(db: AppDb): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM notifications
      WHERE pushed_web_at IS NULL AND severity IN ('warn','urgent')`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Mark everything currently owed as delivered. Called once per send, not per subscription. */
export async function markPushed(db: AppDb, at: number): Promise<void> {
  await db.prepare(
    `UPDATE notifications SET pushed_web_at = ?
      WHERE pushed_web_at IS NULL AND severity IN ('warn','urgent')`,
  ).bind(at).run();
}
