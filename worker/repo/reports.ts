// Stored AI reports. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";

/**
 * Report list, newest period first.
 *
 * `data_json` is deliberately NOT selected: it is the entire report, and a list of 24 of them
 * would ship the whole archive to render a set of headlines.
 *
 * `type` is interpolated as a fixed `WHERE` fragment, but the VALUE is still bound — the caller
 * has already narrowed it to one of three literals, so nothing from the request reaches the SQL
 * text itself.
 */
export async function list(
  db: AppDb, type: string | null, limit: number,
): Promise<Record<string, unknown>[]> {
  const where = type === "week" || type === "month" || type === "custom" ? "WHERE period_type = ?" : "";
  const binds = where ? [type, limit] : [limit];
  const r = await db.prepare(
    `SELECT id, period_type, period_from, period_to, created_at, model, cost_usd, summary
     FROM ai_reports ${where} ORDER BY period_to DESC, created_at DESC LIMIT ?`,
  ).bind(...binds).all();
  return r.results ?? [];
}

/** One report WITH its payload — the only place `data_json` is read. */
export async function find(
  db: AppDb, id: string,
): Promise<({ data_json: string } & Record<string, unknown>) | null> {
  return await db.prepare(
    "SELECT id, period_type, period_from, period_to, created_at, model, cost_usd, summary, data_json FROM ai_reports WHERE id = ?",
  ).bind(id).first<{ data_json: string } & Record<string, unknown>>();
}

/** Hard delete, and idempotent: a report is a derived artefact and can always be regenerated. */
export async function remove(db: AppDb, id: string): Promise<void> {
  await db.prepare("DELETE FROM ai_reports WHERE id = ?").bind(id).run();
}
