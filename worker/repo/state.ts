// `app_state` key/value reads, and the schema introspection the backup export needs.
// See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";

export interface RatesSnapshot {
  rates: Record<string, number>;
  /** Unix seconds, or null when rates have never been fetched. */
  updated: number | null;
}

/** Cached FX rates plus when they were last refreshed — the same source `computeSummary` uses. */
export async function rates(db: AppDb): Promise<RatesSnapshot> {
  const raw = await db.prepare("SELECT value FROM app_state WHERE key = 'rates'").first<{ value: string }>();
  const upd = await db.prepare("SELECT value FROM app_state WHERE key = 'rates_updated'").first<{ value: string }>();
  return {
    rates: raw ? (JSON.parse(raw.value) as Record<string, number>) : {},
    updated: upd ? Number(upd.value) : null,
  };
}

/**
 * Table names for the full backup, read from the SCHEMA rather than a list in code.
 *
 * A dump that silently omits a table added by a later migration is worse than no dump at all: it
 * looks like a backup. Reading `sqlite_master` means a new table is included the day it exists.
 *
 * Everything internal starts with `_` (`_mt_migrations`, `_cf_*` in production,
 * `__miniflare_do_name` in local dev) and no application table does, so one prefix covers all
 * three and the next runtime artefact will not leak into a user's file either.
 */
export async function exportableTables(db: AppDb): Promise<string[]> {
  const r = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'
     ORDER BY name`,
  ).all<{ name: string }>();
  return (r.results ?? []).map((t) => t.name);
}

/**
 * Every row of one table, for the backup.
 *
 * The name comes from `exportableTables`, never from the request — but it is still quoted before
 * interpolation, because interpolating an identifier unquoted is the habit that eventually meets
 * a table with a hyphen in it.
 */
export async function dumpTable(db: AppDb, name: string): Promise<unknown[]> {
  const r = await db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
  return r.results ?? [];
}

/**
 * How much is in this account, in rows — what the first-run checklist reads to decide which
 * setup step is already done.
 *
 * Returns numbers, never null: an empty account is the state EVERY user starts in, and `null`
 * there would say "unknown" about something we do know (`COUNT(*)` over an empty table is 0).
 * The same distinction was a real defect once — `SPEND_COUNT` had no `COALESCE`, so a new user's
 * Statistics rendered blanks where zeros belonged.
 */
export async function rowCounts(db: AppDb): Promise<{ accounts: number; transactions: number }> {
  const accounts = await db.prepare("SELECT COUNT(*) n FROM accounts").first<{ n: number }>();
  const transactions = await db.prepare("SELECT COUNT(*) n FROM transactions").first<{ n: number }>();
  return { accounts: accounts?.n ?? 0, transactions: transactions?.n ?? 0 };
}

/** Latest applied migration, or null when the journal cannot be read. */
export async function schemaVersion(db: AppDb): Promise<string | null> {
  const v = await db.prepare("SELECT MAX(name) AS v FROM _mt_migrations")
    .first<{ v: string | null }>().catch(() => null);
  return v?.v ?? null;
}
