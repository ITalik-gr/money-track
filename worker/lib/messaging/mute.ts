import type { Env } from "../../env.ts";

/**
 * §BIZ-SPLIT — switching the ФОП module off is the person saying «I have no ФОП»: an unread «ЄСВ
 * overdue» left in the feed would keep claiming a debt the screen no longer shows (2026-11-07).
 * Marked read, not deleted — switching back on must not lose history, and `dedup_key` stops a
 * re-announcement anyway.
 */
export async function muteTaxNews(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE notifications SET read_at = ? WHERE entity_type = 'tax_obligation' AND read_at IS NULL",
  ).bind(Math.floor(Date.now() / 1000)).run();
}
