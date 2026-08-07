/**
 * Backups: the copy of a user's data that is NOT inside their Durable Object.
 *
 * WHY THIS EXISTS. Everything a user has lives in exactly one object, and until now there was no
 * second copy of it anywhere — the manual "download everything" button (`/export/all.json`) only
 * helped the user who thought to press it before the day they needed it. `SECURITY.md` recorded
 * that as a deliberate limit; it stopped being defensible once the app held real bank history for
 * people who did not build it.
 *
 * WHAT IS AND IS NOT PROMISED. This is a copy of the ROWS, written to R2 on a schedule and kept
 * for a fortnight. It is not point-in-time recovery and it does not survive the account being
 * deleted — erasure removes the backups too, deliberately, because a "delete my data" that leaves
 * fourteen copies in a bucket is not a deletion.
 *
 * ⚠️ The table list comes from the SCHEMA, never from a list in code. A backup that silently skips
 * a table added by a later migration is worse than no backup: it looks like one. That rule already
 * governs `/export/all.json` and is why both now share `buildDump`.
 */
import type { AppDb } from "./db-shim.ts";
import * as stateRepo from "../../repo/state.ts";

/** Bumped only if the FILE layout changes — not when a migration adds a table. */
export const BACKUP_FORMAT = 1;

/**
 * Encrypted API keys. Excluded from the dump on purpose: the master key is a Worker secret, so
 * the ciphertext is dead weight in a file that lands on someone's disk — and one more copy of a
 * secret is one more place it can leak from.
 */
const SKIP_TABLES = new Set(["user_secrets"]);

/** How many daily copies to keep. Two weeks is long enough to notice "my data looks wrong". */
export const BACKUP_KEEP = 14;

export interface BackupMeta {
  app: "money-track";
  format: number;
  exported_at: number;
  /**
   * The migration ledger's `MAX(name)` — `0038_chats.sql`, not a number. Names are zero-padded,
   * so string comparison orders them exactly as the numbers would, and nothing has to parse it.
   */
  schema_version: string | null;
  rows: Record<string, number>;
  note: string;
}

/**
 * The whole database as one JSON document.
 *
 * Throws rather than returning an empty file when the schema cannot be read: a few-byte "success"
 * is the worst possible outcome here, because the person then believes they have a backup.
 */
export async function buildDump(db: AppDb): Promise<{ json: string; meta: BackupMeta }> {
  const tables = await stateRepo.exportableTables(db);
  if (!tables.length) throw new Error("export_schema_unreadable");

  const data: Record<string, unknown[]> = {};
  const rows: Record<string, number> = {};
  for (const name of tables) {
    if (SKIP_TABLES.has(name)) continue;
    data[name] = await stateRepo.dumpTable(db, name);
    rows[name] = data[name].length;
  }

  const meta: BackupMeta = {
    app: "money-track",
    format: BACKUP_FORMAT,
    exported_at: Math.floor(Date.now() / 1000),
    schema_version: await stateRepo.schemaVersion(db),
    // Counts beside the data, so a truncated or corrupted file is visible without parsing all of it.
    rows,
    note: "Full dump of this account's Durable Object. Encrypted API keys (user_secrets) are excluded.",
  };
  return { json: JSON.stringify({ meta, data }), meta };
}

// ---- R2 ---------------------------------------------------------------------

/**
 * One prefix per user, and ownership is expressed by the KEY rather than by a check somewhere
 * near the read. The receipts bucket already works this way for the same reason: a path that
 * cannot address another user's object needs no separate rule remembering to say so.
 */
export const backupPrefix = (userId: string) => `backups/${userId}/`;
const keyFor = (userId: string, ymd: string) => `${backupPrefix(userId)}${ymd}.json.gz`;

/** A dated copy, `YYYY-MM-DD.json.gz` — the only kind the rotation manages. */
const DATED_RE = /^\d{4}-\d{2}-\d{2}\.json\.gz$/;
/**
 * Names accepted off the wire before being concatenated into a key.
 *
 * `pre-restore` is in here and NOT in `DATED_RE` on purpose: it is the copy taken immediately
 * before a restore, so it must be readable and restorable like any other — it is the way back
 * from the wrong file — but it must never be rotated out by fourteen newer daily copies, which is
 * precisely when someone would reach for it.
 */
export const PRE_RESTORE_NAME = "pre-restore.json.gz";
export const BACKUP_NAME_RE = /^(\d{4}-\d{2}-\d{2}|pre-restore)\.json\.gz$/;

export interface BackupItem {
  name: string;
  size: number;
  created_at: number;
}

export async function listBackups(bucket: R2Bucket, userId: string): Promise<BackupItem[]> {
  const prefix = backupPrefix(userId);
  const listed = await bucket.list({ prefix, limit: 100 });
  return listed.objects
    .map((o) => ({ name: o.key.slice(prefix.length), size: o.size, created_at: Math.floor(o.uploaded.getTime() / 1000) }))
    .sort((a, b) => b.created_at - a.created_at);
}

export async function readBackup(bucket: R2Bucket, userId: string, name: string): Promise<R2ObjectBody | null> {
  if (!BACKUP_NAME_RE.test(name)) return null;
  return bucket.get(backupPrefix(userId) + name);
}

export async function deleteBackup(bucket: R2Bucket, userId: string, name: string): Promise<void> {
  if (!BACKUP_NAME_RE.test(name)) return;
  await bucket.delete(backupPrefix(userId) + name);
}

/** Every copy this user has. Called on account erasure — see the note at the top of the file. */
export async function deleteAllBackups(bucket: R2Bucket, userId: string): Promise<number> {
  const prefix = backupPrefix(userId);
  const listed = await bucket.list({ prefix, limit: 1000 });
  if (!listed.objects.length) return 0;
  await bucket.delete(listed.objects.map((o) => o.key));
  return listed.objects.length;
}

/**
 * Write today's copy and drop the ones past the retention window.
 *
 * Keyed by DAY, so a second run on the same day overwrites instead of adding: the manual button
 * and the nightly cron must not compete for the fourteen slots, or a few impatient clicks would
 * push out every older copy — exactly when someone is worried enough to be clicking.
 *
 * Gzipped into memory rather than streamed: R2 wants a known length for a stream, and a dump of a
 * multi-year account is single-digit megabytes — far inside a Worker's budget, and about a tenth
 * of that once compressed.
 */
export async function storeBackup(
  bucket: R2Bucket, userId: string, json: string, ymd: string,
): Promise<{ key: string; size: number }> {
  const gz = await new Response(
    new Response(json).body!.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();

  const key = keyFor(userId, ymd);
  await bucket.put(key, gz, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { format: String(BACKUP_FORMAT) },
  });

  // Only the dated copies rotate — see `PRE_RESTORE_NAME`.
  const all = (await listBackups(bucket, userId)).filter((o) => DATED_RE.test(o.name));
  const stale = all.slice(BACKUP_KEEP);
  if (stale.length) await bucket.delete(stale.map((o) => backupPrefix(userId) + o.name));

  return { key, size: gz.byteLength };
}

/** Inflate a stored backup back into the JSON text `restoreDump` expects. */
export async function inflate(body: ReadableStream): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}
