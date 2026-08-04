// Category reads. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";

export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  color: string | null;
  is_income: number;
  importance: string | null;
  [key: string]: unknown;
}

/**
 * All categories, income buckets last.
 *
 * Names come back RAW (as seeded, in Ukrainian). Localisation is the caller's job via
 * `localizeCatName`, because the resolution is keyed by the seed name and a user's own category
 * must pass through untouched — a repo that translated on read would silently rename data the
 * user typed.
 */
export async function listAll(db: AppDb): Promise<CategoryRow[]> {
  const r = await db.prepare(
    "SELECT * FROM categories ORDER BY is_income, id",
  ).all<CategoryRow>();
  return r.results ?? [];
}

/**
 * Which of these ids actually exist (§FK-GUARD).
 *
 * There are gaps in the id sequence from deleted rows, so a plausible-looking id — whether it
 * came from a model or from a stale client — lands on nothing and the write fails with
 * `FOREIGN KEY constraint failed`. `INSERT OR IGNORE` does NOT cover this: it suppresses a
 * uniqueness conflict, not a foreign-key violation, so one bad id takes the whole batch down.
 * Filter first, write second.
 */
export async function existingIds(db: AppDb, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await db.prepare(
    `SELECT id FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<{ id: number }>();
  return (r.results ?? []).map((x) => x.id);
}
