// P0.0 SPIKE — TEMPORARY (delete with worker/routes/spike.ts and the SPIKE_DB binding).
//
// The probe body lives here rather than in the route because half of it has to execute
// INSIDE the Durable Object: a database handle cannot cross an RPC boundary, so the DO runs
// this same function against its own SQLite and returns plain JSON. Same code, two backends
// — that is the only way the comparison means anything.
import {
  STATS_JOINS,
  SPEND_WHERE,
  INCOME_WHERE,
  EFF_AMOUNT,
  EFF_CAT_ID,
  EFF_CAT_NAME,
  SPEND_COUNT,
  INCOME_COUNT,
  spendSum,
  incomeSum,
  amountSum,
  uahMult,
} from "../lib/stats.ts";
import type { AppDb, AppResult } from "../lib/db-shim.ts";

// Fixed rates so the ₴ conversion is reproducible and both backends get identical SQL text.
const RATES = { "840": 41.5, "978": 45.0 };
const MULT = uahMult(RATES);
const MONTH_START = Math.floor(Date.UTC(2026, 2, 1) / 1000);
const MONTH_END = Math.floor(Date.UTC(2026, 3, 1) / 1000);

interface Case {
  name: string;
  sql: string;
  binds?: unknown[];
}

const CASES: Case[] = [
  {
    // The heaviest canonical shape in the codebase: STATS_JOINS fan-out plus every §-rule
    // (SPLIT / REFUND / COMPENSATION / transfer exclusion) inside one aggregate.
    name: "canonical_totals",
    sql: `SELECT ${spendSum(MULT)} AS spend,
                 ${incomeSum(MULT)} AS income,
                 ${SPEND_COUNT} AS spend_n,
                 ${INCOME_COUNT} AS income_n
          FROM transactions t ${STATS_JOINS}
          WHERE t.time >= ? AND t.time < ?`,
    binds: [MONTH_START, MONTH_END],
  },
  {
    // Category roll-up: proves the split row fans out into its parts and that
    // COUNT(DISTINCT t.id) is not inflated by the join.
    name: "canonical_by_category",
    sql: `SELECT ${EFF_CAT_ID} AS cat_id, ${EFF_CAT_NAME} AS cat_name,
                 ${amountSum(MULT)} AS total, COUNT(DISTINCT t.id) AS n
          FROM transactions t ${STATS_JOINS}
          WHERE ${SPEND_WHERE} AND t.time >= ?
          GROUP BY ${EFF_CAT_ID}
          ORDER BY total DESC, cat_id`,
    binds: [MONTH_START],
  },
  {
    name: "canonical_income_rows",
    sql: `SELECT t.id, t.merchant, ${EFF_AMOUNT} AS eff
          FROM transactions t ${STATS_JOINS}
          WHERE ${INCOME_WHERE}
          ORDER BY t.id`,
  },
  {
    // Cyrillic LIKE: SQLite case-folds ASCII only, which this project already had to work
    // around (command palette). Both engines must at least agree on the exact-case match.
    name: "bound_like_cyrillic",
    sql: `SELECT id, merchant, amount FROM transactions
          WHERE merchant LIKE ? AND amount < ? ORDER BY id`,
    binds: ["%Сільпо%", 0],
  },
  {
    name: "first_with_coalesce",
    sql: `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
          FROM transactions WHERE currency_code = ?`,
    binds: [840],
  },
  {
    // Types: a string where the other backend returns a number would break money arithmetic
    // silently, since every amount is INTEGER kopecks.
    name: "type_shapes",
    sql: `SELECT 1 AS int_val, 1.5 AS real_val, 'x' AS text_val, NULL AS null_val,
                 CAST(123456789012 AS INTEGER) AS big_int, typeof(amount) AS amount_type
          FROM transactions WHERE id = 'tx_food1'`,
  },
];

export async function probe(db: AppDb): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  for (const c of CASES) {
    const res = await db.prepare(c.sql).bind(...(c.binds ?? [])).all();
    out[c.name] = { results: res.results, meta: res.meta };
  }

  // `.first()` in both overloads — whole row and single column — plus the empty case.
  out["first_row"] = await db.prepare("SELECT id, amount FROM transactions ORDER BY id LIMIT 1").first();
  out["first_col"] = await db.prepare("SELECT COUNT(*) AS n FROM transactions").first<number>("n");
  out["first_null"] = await db.prepare("SELECT id FROM transactions WHERE id = ?").bind("nope").first();

  // AUTOINCREMENT: 10 tables declare it, and it depends on SQLite's internal
  // `sqlite_sequence` table, which the DO runtime restricts. A failure here would mean the
  // schema itself has to change before anything else in P0 can proceed.
  const ins = await db
    .prepare("INSERT INTO categories (name, icon, color, is_income) VALUES (?, ?, ?, 0)")
    .bind("SpikeCat", "dots", "#000000")
    .run();
  out["autoincrement_insert"] = { changes: ins.meta.changes, has_row_id: ins.meta.last_row_id > 0 };
  out["autoincrement_roundtrip"] = await db
    .prepare("SELECT name FROM categories WHERE id = ?")
    .bind(ins.meta.last_row_id)
    .first<{ name: string }>();

  // `INSERT OR IGNORE` onto an existing UNIQUE key must report changes = 0. `notify.ts`
  // counts created notifications with exactly this, so a wrong value makes the feed claim
  // it created events it did not.
  const dedup = await db
    .prepare("INSERT OR IGNORE INTO tx_reimbursements (expense_id, source_tx_id, amount, created_at) VALUES (?, ?, ?, ?)")
    .bind("tx_dinner", "tx_p2pin", 100000, 1)
    .run();
  out["insert_or_ignore_conflict"] = { changes: dedup.meta.changes };

  // An UPDATE that matches nothing must also report 0 — `api.ts` reports "updated N" from it.
  const noop = await db.prepare("UPDATE transactions SET hold = 1 WHERE id = ?").bind("nope").run();
  out["update_no_match"] = { changes: noop.meta.changes };

  // Foreign keys: §FK-GUARD exists because D1 raises on a non-existent category id. If the
  // DO does not enforce FKs, that guard silently stops guarding.
  try {
    await db
      .prepare("INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id) VALUES (?, ?, 'manual', 1, -100, 980, ?)")
      .bind("tx_fk_probe", "acc_uah", 999999)
      .run();
    out["fk_enforced"] = false;
  } catch (e) {
    out["fk_enforced"] = true;
    out["fk_error_has_text"] = (e instanceof Error ? e.message : String(e)).length > 0;
  }

  // Batch atomicity: the second statement is invalid, so nothing from the batch may land.
  // `transfers.ts` pairs both sides of a transfer in one batch — a half-applied batch would
  // leave one row carrying a transfer_pair_id its partner never got, and the transactions
  // list hides the "+" side by exactly that column.
  try {
    await db.batch([
      db.prepare("INSERT INTO transactions (id, account_id, source, time, amount, currency_code) VALUES ('tx_batch_a', 'acc_uah', 'manual', 1, -1, 980)"),
      db.prepare("INSERT INTO transactions (id, account_id, source, time, amount, currency_code) VALUES ('tx_batch_b', 'acc_missing', 'manual', 1, -1, 980)"),
    ]);
    out["batch_failed"] = false;
  } catch {
    out["batch_failed"] = true;
  }
  out["batch_rolled_back"] =
    (await db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id LIKE 'tx_batch_%'").first<number>("n")) === 0;

  // A successful batch must return one result per statement, in order.
  const okBatch = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM transactions"),
    db.prepare("SELECT COUNT(*) AS n FROM tx_splits"),
  ]);
  out["batch_ok"] = okBatch.map((r: AppResult<{ n: number }>) => r.results[0]?.n);

  return out;
}
