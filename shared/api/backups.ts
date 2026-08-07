// Response shapes of `/api/backups/*`. See `./analytics.ts` for why this file exists.

export interface BackupItem {
  /** `YYYY-MM-DD.json.gz`, or `pre-restore.json.gz` for the safety copy taken before a restore. */
  name: string;
  /** Compressed size in bytes — what the list shows, and the only signal that a copy is thin. */
  size: number;
  created_at: number;
}

export interface BackupList {
  backups: BackupItem[];
  /** How many dated copies are kept, so the screen can say it rather than the UI guessing. */
  keep: number;
}

/**
 * What a restore actually did.
 *
 * Every field exists because the alternative is a silent "ok": a backup from an older schema is
 * restorable, but only after saying which tables and columns it could not place. See
 * `worker/do/restore.ts`.
 */
export interface RestoreResult {
  ok: boolean;
  restored: Record<string, number>;
  skipped_tables: string[];
  dropped_columns: string[];
  file_schema_version: string | null;
  db_schema_version: string | null;
}
