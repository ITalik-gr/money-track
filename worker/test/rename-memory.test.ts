/**
 * §RENAME-MEMORY — the name the person keeps typing over a bank description is applied for them,
 * says so on the operation, and can be undone.
 *
 * Runs the real ingest writer against the real schema: the behaviour lives in the join between the
 * writer, `name_locked` and the change journal, and a test of the picker alone would pass while
 * any of those three drifted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";
import { upsertCanonicalTx } from "../repo/ingest.ts";
import { pickRememberedName } from "../repo/rename-memory.ts";
import * as changes from "../repo/ai-changes.ts";
import type { AppDb } from "../lib/platform/db-shim.ts";

const T0 = Date.UTC(2026, 8, 1, 9) / 1000;
const DESC = "Переказ на картку 5375****1234";

function db(): MemDb {
  const m = migratedDb();
  seed(m);
  for (const t of ["tx_splits", "tx_reimbursements", "ai_changes", "transactions", "merchant_aliases"]) m.raw.prepare(`DELETE FROM ${t}`).run();
  return m;
}
const app = (m: MemDb) => m as unknown as AppDb;

async function arrive(m: MemDb, id: string, amount: number, at: number, description = DESC) {
  await upsertCanonicalTx(app(m), {
    id, account_id: "acc-uah", time: at, amount, currency_code: 980, description, raw: { id, description },
  }, { source: "mono", onConflict: "refresh" });
}
/** What the detail page's save does to a rename (services/transactions.ts): name + name_locked=1. */
function renameByHand(m: MemDb, id: string, name: string) {
  m.raw.prepare("UPDATE transactions SET merchant = ?, name_locked = 1 WHERE id = ?").run(name, id);
}
const row = (m: MemDb, id: string) =>
  ({ ...(m.raw.prepare("SELECT merchant, name_locked FROM transactions WHERE id = ?").get(id) as { merchant: string; name_locked: number }) });

test("picker: two agreeing renames near the amount, nothing less", () => {
  const s = (merchant: string, amount: number) => ({ merchant, amount });
  assert.equal(pickRememberedName([s("Оренда", -1_250_000)], -1_250_000), null, "one rename is a one-off");
  assert.equal(pickRememberedName([s("Оренда", -1_250_000), s("Оренда", -1_200_000)], -1_300_000), "Оренда");
  assert.equal(pickRememberedName([s("Оренда", -1_250_000), s("Квартира", -1_250_000)], -1_250_000), null, "not settled");
  assert.equal(pickRememberedName([s("Оренда", -1_250_000), s("Оренда", -1_250_000)], -30_000), null, "a coffee is not rent");
  assert.equal(pickRememberedName([s("Оренда", -1_250_000), s("Оренда", -1_250_000)], 1_250_000), null, "money in is not rent");
});

test("after two renames, the third arrival carries the name, marked and undoable", async () => {
  const m = db();
  await arrive(m, "a", -1_250_000, T0);
  renameByHand(m, "a", "Оренда");
  await arrive(m, "b", -1_250_000, T0 + 30 * 86400);
  assert.equal(row(m, "b").merchant, DESC, "one rename is not enough");
  renameByHand(m, "b", "Оренда");

  await arrive(m, "c", -1_300_000, T0 + 60 * 86400);
  assert.deepEqual(row(m, "c"), { merchant: "Оренда", name_locked: 2 });
  await arrive(m, "coffee", -30_000, T0 + 60 * 86400 + 1);
  assert.equal(row(m, "coffee").merchant, DESC, "a different amount under the same description is left alone");

  const log = await changes.forTx(app(m), "c");
  assert.equal(log.length, 1);
  assert.deepEqual([log[0]!.field, log[0]!.old_value, log[0]!.new_value, log[0]!.source], ["merchant", DESC, "Оренда", "rename_memory"]);

  assert.deepEqual(await changes.revert(app(m), log[0]!, T0 + 61 * 86400), { ok: true });
  assert.deepEqual(row(m, "c"), { merchant: DESC, name_locked: 0 });
});

test("the memory does not teach itself: auto-named rows are not evidence", async () => {
  const m = db();
  await arrive(m, "a", -1_250_000, T0);
  renameByHand(m, "a", "Оренда");
  // Two rows named by the memory (name_locked = 2) plus one real rename: still only ONE vote.
  m.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, hold, is_transfer, created_at, raw_json, name_locked)
     VALUES ('x1','acc-uah','mono',?,-1250000,980,'Оренда',0,0,0,?,2), ('x2','acc-uah','mono',?,-1250000,980,'Оренда',0,0,0,?,2)`,
  ).run(T0 + 1, JSON.stringify({ description: DESC }), T0 + 2, JSON.stringify({ description: DESC }));
  await arrive(m, "c", -1_250_000, T0 + 60 * 86400);
  assert.equal(row(m, "c").merchant, DESC);
});

test("an explicit alias outranks the memory", async () => {
  const m = db();
  await arrive(m, "a", -1_250_000, T0);
  renameByHand(m, "a", "Оренда");
  await arrive(m, "b", -1_250_000, T0 + 1);
  renameByHand(m, "b", "Оренда");
  m.raw.prepare(
    `INSERT INTO merchant_aliases (match_type, raw_key, display_name, source, created_at) VALUES ('mono_desc', ?, 'Квартира на Липках', 'manual', 0)`,
  ).run(DESC);
  await arrive(m, "c", -1_250_000, T0 + 2);
  assert.deepEqual(row(m, "c"), { merchant: "Квартира на Липках", name_locked: 0 });
});
