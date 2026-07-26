// Migration runner for the per-user Durable Object.
//
// The DO holds the SAME schema the D1 database holds — migrations/0001…0030 applied in
// filename order. Running the real files (rather than a hand-written "current schema"
// snapshot) is deliberate: a second, drifting definition of the schema is how the money
// invariants (integer kopecks, COALESCE(parent_id, id) roll-up, §SPLIT, §REFUND,
// §COMPENSATION) would quietly diverge between the two backends.
import { MIGRATIONS } from "./migrations.generated.ts";
import { splitSqlStatements } from "./sql-split.ts";

/** Bookkeeping table. `sqlite_`/`_cf_` prefixes are reserved by the DO runtime; `_mt_` is not. */
const LEDGER = "_mt_migrations";

export interface MigrationReport {
  applied: string[];
  skipped: number;
}

/**
 * Applies every not-yet-applied migration. Idempotent: a restarted DO re-reads the ledger
 * and applies nothing.
 *
 * Call it from the DO constructor inside `blockConcurrencyWhile` so no request can observe
 * a half-built schema.
 */
export function runMigrations(sql: SqlStorage): MigrationReport {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       name       TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const applied = new Set(
    sql.exec<{ name: string }>(`SELECT name FROM ${LEDGER}`).toArray().map((r) => r.name),
  );

  const report: MigrationReport = { applied: [], skipped: 0 };
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) {
      report.skipped++;
      continue;
    }
    // Statement by statement rather than handing the whole file to `sql.exec`.
    // `SqlStorage.exec` does accept a multi-statement script, but it rejects a fragment that
    // contains no statement — and several migration files end with a trailing comment after
    // the last `;`, which is exactly such a fragment ("SQL code did not contain a statement",
    // hit on the first run of this runner). Splitting also names the offending statement when
    // a migration fails, instead of blaming the whole file.
    for (const stmt of splitSqlStatements(m.sql)) sql.exec(stmt);
    sql.exec(`INSERT INTO ${LEDGER} (name, applied_at) VALUES (?, ?)`, m.name, Date.now());
    report.applied.push(m.name);
  }
  return report;
}

/** Names of all embedded migrations, in apply order. */
export function migrationNames(): string[] {
  return MIGRATIONS.map((m) => m.name);
}
