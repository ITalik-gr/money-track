/**
 * Backup and restore.
 *
 * Restore is the only operation in the app that deletes data on purpose, and the failure mode is
 * not "it errored" — it is "it half-worked", leaving a database that is neither the backup nor
 * what was there before. So the cases here are the ones where it would be tempting to let it
 * proceed: a file from another app, a file from a newer schema, a value SQLite cannot store, and
 * a file whose tables no longer all exist.
 *
 * The `SqlStorage` adapter below is deliberately thin. `restoreDump` takes the raw storage and a
 * transaction runner as ARGUMENTS precisely so the destructive logic can be exercised without a
 * Durable Object — the same shape `import-legacy.ts` uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { migratedDb, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";
import { buildDump } from "../lib/platform/backup.ts";
import { restoreDump } from "../do/restore.ts";

/** Enough of `SqlStorage` for `restoreDump`: `exec(sql, ...binds).toArray()`. */
function storage(db: DatabaseSync) {
  return {
    exec: (q: string, ...binds: unknown[]) => {
      // A PRAGMA that SETS returns nothing and cannot be prepared; one that ASKS (`table_info`)
      // returns rows and must be.
      if (/^\s*PRAGMA\s+[a-z_]+\s*=/i.test(q)) { db.exec(q); return { toArray: () => [] }; }
      const st = db.prepare(q);
      st.setReadBigInts(false);
      // ⚠️ EAGER, like the real `SqlStorage.exec`: it runs the statement when called, and returns
      // a cursor over rows that already exist. A lazy adapter (`toArray: () => st.all()`) type-checks
      // and silently executes NOTHING for the statements nobody reads rows from — every DELETE and
      // every INSERT in a restore. It reported a perfect restore into an untouched database.
      const rows = st.all(...(binds as never[]));
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

function txRunner(db: DatabaseSync) {
  return (fn: () => void) => {
    db.exec("BEGIN");
    try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
}

const count = (db: MemDb, table: string) =>
  (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("backup: a dump restores into an empty database row for row", async () => {
  const source = migratedDb();
  seed(source);
  const { json, meta } = await buildDump(source);

  // Every table the fixture fills must be IN the dump — the table list comes from the schema, so
  // this is what catches a future migration whose table nobody remembered to back up.
  assert.ok(meta.rows.transactions > 0, "fixture transactions must be in the dump");
  assert.ok(meta.rows.accounts > 0);
  assert.equal(meta.rows.user_secrets, undefined, "encrypted keys must never enter a dump");

  const target = migratedDb();
  const report = restoreDump(storage(target.raw), txRunner(target.raw), json);

  assert.equal(report.ok, true);
  assert.equal(count(target, "transactions"), count(source, "transactions"));
  assert.equal(count(target, "accounts"), count(source, "accounts"));
  assert.equal(count(target, "categories"), count(source, "categories"));
  assert.equal(count(target, "tx_splits"), count(source, "tx_splits"));
  assert.deepEqual(report.skipped_tables, []);
  assert.deepEqual(report.dropped_columns, []);

  // Not just counts: a restore that writes the right NUMBER of wrong rows is the failure a
  // count-only assertion would pass.
  const one = (db: MemDb) =>
    db.raw.prepare("SELECT id, amount, merchant FROM transactions ORDER BY id LIMIT 1").get();
  assert.deepEqual(one(target), one(source));
});

test("backup: restoring over existing data REPLACES it, leaving nothing of the old rows", async () => {
  const source = migratedDb();
  seed(source);
  const { json } = await buildDump(source);

  const target = migratedDb();
  seed(target);
  target.raw.exec(
    "INSERT INTO transactions (id, account_id, source, currency_code, time, amount, merchant) " +
    "VALUES ('only-here', 'acc-uah', 'manual', 980, 1778000000, -5000, 'Не з бекапу')",
  );
  assert.equal(count(target, "transactions"), count(source, "transactions") + 1);

  restoreDump(storage(target.raw), txRunner(target.raw), json);

  assert.equal(count(target, "transactions"), count(source, "transactions"));
  assert.equal(
    (target.raw.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id = 'only-here'").get() as { n: number }).n,
    0,
    "a row absent from the backup must be gone after a restore, not merged in",
  );
});

test("backup: a file this schema cannot fully place is restored, and SAYS what it dropped", async () => {
  const source = migratedDb();
  seed(source);
  const parsed = JSON.parse((await buildDump(source)).json) as {
    data: Record<string, Record<string, unknown>[]>;
  };
  // A table from a version that had one, and a column since removed.
  parsed.data.long_gone_table = [{ id: 1 }];
  for (const row of parsed.data.accounts) row.retired_column = "x";

  const target = migratedDb();
  const report = restoreDump(storage(target.raw), txRunner(target.raw), JSON.stringify(parsed));

  assert.deepEqual(report.skipped_tables, ["long_gone_table"]);
  assert.ok(report.dropped_columns.includes("accounts.retired_column"));
  // The point of reporting instead of refusing: everything placeable still landed.
  assert.equal(count(target, "accounts"), count(source, "accounts"));
});

test("backup: a file from a NEWER schema is refused rather than partly applied", async () => {
  const source = migratedDb();
  seed(source);
  const parsed = JSON.parse((await buildDump(source)).json) as { meta: Record<string, unknown> };
  parsed.meta.schema_version = "9999_from_the_future.sql";

  const target = migratedDb();
  // The harness applies the .sql files directly, so give it the ledger the DO keeps.
  target.raw.exec("CREATE TABLE _mt_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  target.raw.exec("INSERT INTO _mt_migrations VALUES ('0038_chats.sql', 0)");
  seed(target);

  assert.throws(
    () => restoreDump(storage(target.raw), txRunner(target.raw), JSON.stringify(parsed)),
    /newer version/,
  );
  assert.ok(count(target, "transactions") > 0, "a refused restore must not have deleted anything");
});

test("backup: a file that is not ours is refused before anything is deleted", async () => {
  const target = migratedDb();
  seed(target);
  const before = count(target, "transactions");

  assert.throws(() => restoreDump(storage(target.raw), txRunner(target.raw), "{}"), /not a Money Track/);
  assert.throws(() => restoreDump(storage(target.raw), txRunner(target.raw), "not json"), /not valid JSON/);
  assert.equal(count(target, "transactions"), before);
});

test("backup: a value SQLite cannot store aborts the whole restore, not half of it", async () => {
  const source = migratedDb();
  seed(source);
  const parsed = JSON.parse((await buildDump(source)).json) as {
    data: Record<string, Record<string, unknown>[]>;
  };
  // A structured value where a scalar belongs — what a hand-edited or half-written file looks like.
  parsed.data.transactions[0].amount = { oops: true };

  const target = migratedDb();
  seed(target);
  const before = count(target, "transactions");

  assert.throws(() => restoreDump(storage(target.raw), txRunner(target.raw), JSON.stringify(parsed)));
  assert.equal(count(target, "transactions"), before, "the DELETEs must not have happened");
});
