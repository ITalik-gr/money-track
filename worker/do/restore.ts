/**
 * Putting a backup back.
 *
 * This is the only operation in the app that DESTROYS data on purpose, so the shape of it matters
 * more than the size: it replaces the contents of every table the file knows about, and a partial
 * result — half the tables replaced, half not — would be a database that is neither the backup nor
 * what was there before. Hence one `transactionSync`: it either all lands or none of it does.
 *
 * It lives beside `import-legacy.ts` and `UserDO.reset()` rather than in `repo/` because it needs
 * the raw `SqlStorage` those two need, for the same reason: `PRAGMA defer_foreign_keys` and a
 * synchronous transaction are not part of the `AppDb` surface the application talks to, and
 * deliberately so — nothing else may reach for them.
 *
 * SCHEMA DRIFT is handled by intersection, not by hope:
 *   • a table in the file that this schema no longer has → skipped and REPORTED;
 *   • a column in the file that the table no longer has → dropped and REPORTED;
 *   • a column this schema added since → left at its default, which is what the migration decided
 *     it should be for a row that predates it.
 * The one case that is refused outright is a file from a NEWER schema: its rows can carry columns
 * and tables we have no place for, and quietly discarding them would restore something the user
 * would reasonably call "my data", minus parts of it, without saying so.
 */
export interface RestoreReport {
  ok: boolean;
  /** Tables replaced, with the number of rows written into each. */
  restored: Record<string, number>;
  /** Present in the file, absent from this schema. */
  skipped_tables: string[];
  /** `table.column` pairs the file had and this schema does not. */
  dropped_columns: string[];
  file_schema_version: string | null;
  db_schema_version: string | null;
}

/** The ledger is the schema's own bookkeeping — restoring it would rewrite migration history. */
const NEVER_RESTORE = new Set(["_mt_migrations", "user_secrets"]);

interface BackupFile {
  meta?: { app?: string; format?: number; schema_version?: string | null };
  data?: Record<string, Record<string, unknown>[]>;
}

export function restoreDump(
  sql: SqlStorage,
  transactionSync: (fn: () => void) => void,
  json: string,
): RestoreReport {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(json) as BackupFile;
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (parsed?.meta?.app !== "money-track" || !parsed.data || typeof parsed.data !== "object") {
    throw new Error("This is not a Money Track backup file.");
  }

  // The ledger keys on migration FILENAME (`0038_chats.sql`), and the names are zero-padded, so
  // comparing them as strings orders them exactly as the numbers do — no parsing to get wrong.
  const dbVersion = currentSchemaVersion(sql);
  const fileVersion = typeof parsed.meta.schema_version === "string" ? parsed.meta.schema_version : null;
  if (fileVersion != null && dbVersion != null && fileVersion > dbVersion) {
    throw new Error(
      `This backup was made by a newer version of the app (schema ${fileVersion}, this one is at ${dbVersion}). ` +
      "Restoring it would silently drop the parts this version has no place for.",
    );
  }

  // What this database actually has, read now rather than assumed from the migration number: the
  // two can disagree on an object that was restored, reset or migrated by hand.
  const liveTables = new Map<string, Set<string>>();
  for (const t of sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'`,
  ).toArray()) {
    const cols = sql.exec<{ name: string }>(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).toArray();
    liveTables.set(t.name, new Set(cols.map((c) => c.name)));
  }

  const report: RestoreReport = {
    ok: true,
    restored: {},
    skipped_tables: [],
    dropped_columns: [],
    file_schema_version: fileVersion,
    db_schema_version: dbVersion,
  };

  // Everything is prepared BEFORE the transaction opens, so a malformed file fails without having
  // deleted anything. Inside the transaction there is nothing left that can decide to throw.
  const plan: { table: string; columns: string[]; values: SqlStorageValue[][] }[] = [];
  for (const [table, rows] of Object.entries(parsed.data)) {
    if (NEVER_RESTORE.has(table)) continue;
    const live = liveTables.get(table);
    if (!live) { report.skipped_tables.push(table); continue; }
    if (!Array.isArray(rows)) { report.skipped_tables.push(table); continue; }

    // Column set from the union of the rows, not from the first one: `SELECT *` produces uniform
    // keys today, but a hand-edited file is exactly the kind of thing that gets restored.
    const fileCols = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r ?? {})) fileCols.add(k);
    const columns: string[] = [];
    for (const c of fileCols) {
      if (live.has(c)) columns.push(c);
      else report.dropped_columns.push(`${table}.${c}`);
    }
    // Values are converted HERE, not in the loop below: `toSqlValue` can reject a row, and a
    // rejection that happens after the DELETEs would have to be undone rather than avoided.
    plan.push({ table, columns, values: rows.map((r) => columns.map((c) => toSqlValue(r?.[c]))) });
  }

  transactionSync(() => {
    // Order-independent by construction: with FK checks deferred to commit, the tables can be
    // emptied and refilled in whatever order the file happens to list them. The alternative is a
    // topological sort of the FK graph that has to be right every time a migration adds a table.
    sql.exec("PRAGMA defer_foreign_keys = ON");

    for (const { table } of plan) sql.exec(`DELETE FROM "${q(table)}"`);

    for (const { table, columns, values } of plan) {
      report.restored[table] = 0;
      if (!columns.length || !values.length) continue;
      const stmt =
        `INSERT INTO "${q(table)}" (${columns.map((c) => `"${q(c)}"`).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`;
      for (const row of values) {
        sql.exec(stmt, ...row);
        report.restored[table]++;
      }
    }
  });

  return report;
}

const q = (ident: string) => ident.replace(/"/g, '""');

/**
 * JSON has four scalar types and SQLite takes three. `true`/`false` become 1/0 (which is how they
 * were stored in the first place — SQLite has no boolean), and anything structured is refused
 * rather than stringified: a silently JSON-encoded object in an INTEGER column reads back as a
 * number that is not a number.
 */
function toSqlValue(v: unknown): SqlStorageValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`Backup contains a value this schema cannot store: ${JSON.stringify(v).slice(0, 80)}`);
}

function currentSchemaVersion(sql: SqlStorage): string | null {
  try {
    const r = sql.exec<{ v: string | null }>("SELECT MAX(name) AS v FROM _mt_migrations").toArray();
    return r[0]?.v ?? null;
  } catch {
    return null;
  }
}
