// Feedback from users, and the daily demo-visit tally. Both live in the shared DIRECTORY database
// (see `migrations-directory/0006`, `0007`), which is why neither goes through `worker/repo/` —
// that layer owns the USER's own object, and this data is by definition not one user's.
import type { Env } from "../../env.ts";
import { localYmd } from "../finance/stats.ts";
import type { DemoDay, FeedbackRow } from "../../../shared/api/feedback.ts";

export interface FeedbackInput {
  userId: string | null;
  email: string | null;
  kind: string;
  message: string;
  page: string | null;
  userAgent: string | null;
}

const KINDS = new Set(["bug", "idea", "other"]);
export const FEEDBACK_MAX_CHARS = 2000;
/** Per sender, per day. High enough that nobody hits it while reporting real problems. */
export const FEEDBACK_DAILY_LIMIT = 10;

export async function addFeedback(db: D1Database, f: FeedbackInput): Promise<void> {
  await db.prepare(
    `INSERT INTO feedback (user_id, email, kind, message, page, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    f.userId,
    f.email,
    KINDS.has(f.kind) ? f.kind : "other",
    f.message.slice(0, FEEDBACK_MAX_CHARS),
    f.page?.slice(0, 200) ?? null,
    f.userAgent?.slice(0, 300) ?? null,
    Math.floor(Date.now() / 1000),
  ).run();
}

/**
 * How many messages this sender has already sent today.
 *
 * Counted from the rows themselves rather than from a counter key: the rows are the thing being
 * limited, so there is nothing to keep in sync, and a table this small makes the count free.
 * A demo visitor has no id — they are limited as one anonymous bucket, which is the honest
 * accounting when we cannot tell two of them apart.
 */
export async function feedbackToday(db: D1Database, userId: string | null): Promise<number> {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM feedback
      WHERE created_at >= ? AND ${userId ? "user_id = ?" : "user_id IS NULL"}`,
  ).bind(...(userId ? [since, userId] : [since])).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listFeedback(db: D1Database, limit = 100): Promise<FeedbackRow[]> {
  const r = await db.prepare(
    `SELECT id, user_id, email, kind, message, page, user_agent, created_at, handled_at
       FROM feedback ORDER BY created_at DESC LIMIT ?`,
  ).bind(Math.min(limit, 200)).all<FeedbackRow>();
  return r.results ?? [];
}

export async function markFeedbackHandled(db: D1Database, id: number, on: boolean): Promise<void> {
  await db.prepare("UPDATE feedback SET handled_at = ? WHERE id = ?")
    .bind(on ? Math.floor(Date.now() / 1000) : null, id).run();
}

// ---- demo visits ------------------------------------------------------------

/**
 * One more sandbox started today.
 *
 * Best-effort, exactly like `registerDemoSession` beside it: a statistic must never be the reason
 * a visitor cannot see the demo. Called only after the sandbox seeded successfully, so it counts
 * demos that actually opened.
 */
export async function recordDemoVisit(env: Env): Promise<void> {
  const day = localYmd(Math.floor(Date.now() / 1000));
  try {
    await env.DIRECTORY.prepare(
      `INSERT INTO demo_daily (day, sandboxes) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET sandboxes = sandboxes + 1`,
    ).bind(day).run();
  } catch (e) {
    console.error("[demo] recordDemoVisit failed:", e instanceof Error ? e.message : e);
  }
}

/** The last `days` days that had at least one visit, newest first. */
export async function demoVisits(db: D1Database, days = 60): Promise<DemoDay[]> {
  const r = await db.prepare(
    "SELECT day, sandboxes FROM demo_daily ORDER BY day DESC LIMIT ?",
  ).bind(Math.min(days, 365)).all<DemoDay>();
  return r.results ?? [];
}
