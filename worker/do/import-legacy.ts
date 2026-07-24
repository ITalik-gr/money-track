// One-off migration: the single-user D1 database → the owner's Durable Object (PLATFORM.md §9, P0.7).
//
// Runs INSIDE the Durable Object, reading from the old D1 through the binding the object still
// has. That is the whole trick: no dump files, no chunked HTTP upload, no script juggling two
// credentials — just a read from one handle and a write to another, in the same isolate.
//
// Design decisions worth stating, because each closes a way this could destroy data:
//
//   • Everything is read BEFORE anything is written. A half-read source combined with a
//     half-written destination is the one state from which there is no clean recovery.
//   • All writes happen in ONE `transactionSync` with `PRAGMA defer_foreign_keys` — foreign
//     keys are checked at commit, so table order does not matter and a broken reference aborts
//     the whole import instead of leaving orphans. (The DO enforces FKs; confirmed by the P0.0
//     spike.)
//   • `INSERT OR REPLACE`, because the object already ran the migrations and therefore already
//     holds the seeded categories from 0002. The real data must win over the seed.
//   • Idempotent by construction: running it twice lands the same rows. It refuses to run when
//     the object already holds transactions, so a stray second call cannot mix two histories.
import type { AppDb } from "../lib/db-shim.ts";

/** Tables copied verbatim. `user_secrets` is excluded: those are per-user, and the old
 *  single-user deployment kept its credentials in Worker secrets, not in this table. */
const TABLES = [
  "categories",
  "accounts",
  "rules",
  "merchant_aliases",
  "planned_payments",
  "planned_dismissed",
  "receipts",
  "receipt_items",
  "transactions",
  "transaction_tags",
  "budgets",
  "app_state",
  "savings_goals",
  "event_groups",
  "ai_reports",
  "facts",
  "health_history",
  "tx_splits",
  "notifications",
  "account_balance_history",
  "rate_history",
  "tx_reimbursements",
  "knowledge_docs",
] as const;

export interface ImportReport {
  ok: boolean;
  error?: string;
  /** rows read from the old database, per table */
  read: Record<string, number>;
  /** rows present in the object after the import, per table */
  written: Record<string, number>;
  /** the numbers that must match before/after — this is what makes the run verifiable */
  checks: {
    tx_count_before: number;
    tx_count_after: number;
    tx_amount_sum_before: number;
    tx_amount_sum_after: number;
    accounts_balance_sum_before: number;
    accounts_balance_sum_after: number;
  };
}

interface Row {
  [column: string]: unknown;
}

async function readTable(db: AppDb, table: string): Promise<Row[] | null> {
  try {
    return (await db.prepare(`SELECT * FROM "${table}"`).all<Row>()).results;
  } catch {
    // A table the old database never had (added by a later migration, or simply absent).
    // Skipping is correct: the destination already has it, empty.
    return null;
  }
}

async function scalar(db: AppDb, sql: string): Promise<number> {
  try {
    const v = await db.prepare(sql).first<number>("v");
    return Number(v ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Copies the legacy database into `target`.
 *
 * @param legacy the old shared D1 (still bound to the Worker and to this object)
 * @param target this object's own SQLite, via the shim
 * @param runInTransaction runs a synchronous callback atomically (`ctx.storage.transactionSync`)
 */
export async function importLegacy(
  legacy: AppDb,
  target: AppDb,
  runInTransaction: (fn: () => void) => void,
  exec: (sql: string, ...binds: unknown[]) => void,
): Promise<ImportReport> {
  const read: Record<string, number> = {};
  const written: Record<string, number> = {};

  // Refuse when this object already holds a history. Merging two sets of transactions would
  // double every number in the canon, and there would be no way to tell which rows came from
  // where afterwards.
  const already = await scalar(target, "SELECT COUNT(*) AS v FROM transactions");
  if (already > 0) {
    return {
      ok: false,
      error: `target already has ${already} transactions — refusing to merge two histories`,
      read,
      written,
      checks: {
        tx_count_before: 0, tx_count_after: already,
        tx_amount_sum_before: 0, tx_amount_sum_after: 0,
        accounts_balance_sum_before: 0, accounts_balance_sum_after: 0,
      },
    };
  }

  const before = {
    tx_count: await scalar(legacy, "SELECT COUNT(*) AS v FROM transactions"),
    tx_sum: await scalar(legacy, "SELECT COALESCE(SUM(amount), 0) AS v FROM transactions"),
    acc_sum: await scalar(legacy, "SELECT COALESCE(SUM(balance), 0) AS v FROM accounts"),
  };

  // ---- read everything first ------------------------------------------------------------
  const data: { table: string; rows: Row[] }[] = [];
  for (const table of TABLES) {
    const rows = await readTable(legacy, table);
    if (rows === null) continue;
    read[table] = rows.length;
    if (rows.length) data.push({ table, rows });
  }

  // ---- then write it, atomically ----------------------------------------------------------
  try {
    runInTransaction(() => {
      exec("PRAGMA defer_foreign_keys = ON");
      for (const { table, rows } of data) {
        const columns = Object.keys(rows[0]!);
        const placeholders = columns.map(() => "?").join(", ");
        const sql = `INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
        for (const row of rows) exec(sql, ...columns.map((c) => row[c] ?? null));
      }
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      read,
      written,
      checks: {
        tx_count_before: before.tx_count, tx_count_after: 0,
        tx_amount_sum_before: before.tx_sum, tx_amount_sum_after: 0,
        accounts_balance_sum_before: before.acc_sum, accounts_balance_sum_after: 0,
      },
    };
  }

  for (const table of TABLES) {
    written[table] = await scalar(target, `SELECT COUNT(*) AS v FROM "${table}"`);
  }

  const after = {
    tx_count: await scalar(target, "SELECT COUNT(*) AS v FROM transactions"),
    tx_sum: await scalar(target, "SELECT COALESCE(SUM(amount), 0) AS v FROM transactions"),
    acc_sum: await scalar(target, "SELECT COALESCE(SUM(balance), 0) AS v FROM accounts"),
  };

  return {
    // `ok` means the money actually matches, not merely that no statement threw. A silent
    // partial copy is the failure this whole card exists to prevent.
    ok: before.tx_count === after.tx_count && before.tx_sum === after.tx_sum && before.acc_sum === after.acc_sum,
    read,
    written,
    checks: {
      tx_count_before: before.tx_count,
      tx_count_after: after.tx_count,
      tx_amount_sum_before: before.tx_sum,
      tx_amount_sum_after: after.tx_sum,
      accounts_balance_sum_before: before.acc_sum,
      accounts_balance_sum_after: after.acc_sum,
    },
  };
}
