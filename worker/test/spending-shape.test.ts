/**
 * §SHAPE — the three questions the Statistics page could not answer.
 *
 * Two months with the same total and the same categories can be completely different months. The
 * page had an average cheque and a biggest cheque, which are precisely the two figures that hide
 * the difference between «38% витрат — це 214 покупок» and «38% — це три платежі».
 *
 * What is pinned here is not the arithmetic but the three decisions that make the arithmetic mean
 * something: the unit is the WHOLE transaction, a refund is not a cheque, and a zero-limit
 * envelope is still an envelope.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spendingShape } from "../lib/finance/spending-shape.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);
const env = (m: MemDb) => testEnv(m) as unknown as Env;
const RANGE = { from: NOW - 30 * 86400, to: NOW };
// `mult: "1"` — the fixture is hryvnia-only, so the base conversion is the identity and the
// thresholds stay the round numbers the module declares.
const V = { mult: "1", curFilter: "" };
const RATES = { 840: 41, 978: 45 } as unknown as Parameters<typeof spendingShape>[3];

/**
 * Empty the ledger before seeding a hand-made month.
 *
 * Children first: `tx_splits`, `tx_reimbursements` and `ai_changes` all reference `transactions`,
 * and the DO runs with foreign keys ON — deleting the parent alone fails, which is the shape of
 * the real constraint and not something to switch off in a test.
 */
function clearTx(m: MemDb) {
  for (const t of ["tx_splits", "tx_reimbursements", "ai_changes", "transactions"]) {
    m.raw.prepare(`DELETE FROM ${t}`).run();
  }
}

/** A spend row, five days back, in a category of the caller's choosing. */
function spend(m: MemDb, id: string, amount: number, category: number | null, daysAgo = 5) {
  m.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
       category_id, hold, is_transfer, created_at)
     VALUES (?, 'acc-uah', 'manual', ?, ?, 980, 'Shop', ?, 0, 0, 0)`,
  ).run(id, NOW - daysAgo * 86400, -amount, category);
}

test("§SHAPE: a period is bucketed by the size of the actual payment", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    spend(m, "s1", 5_000, 1);       //   50 — under 100
    spend(m, "s2", 30_000, 1);      //  300 — 100..500
    spend(m, "s3", 150_000, 1);     // 1500 — 500..2000
    spend(m, "s4", 400_000, 1);     // 4000 — 2000 and up
    const o = await spendingShape(env(m), V, RANGE, RATES);

    await t.test("four buckets, each with its count and its share", () => {
      assert.equal(o.buckets.length, 4, "three thresholds make four buckets");
      assert.deepEqual(o.buckets.map((b) => b.n), [1, 1, 1, 1]);
      assert.deepEqual(o.buckets.map((b) => b.spent), [5_000, 30_000, 150_000, 400_000]);
      assert.equal(o.buckets[3].up_to, null, "the top bucket is open-ended");
    });

    await t.test("the shares add up to the period, so the bar can be read as the month", () => {
      assert.equal(o.buckets.reduce((s, b) => s + b.spent, 0), o.spend);
    });

    await t.test("an empty bucket is returned, not omitted", () => {
      const m2 = migratedDb();
      seed(m2);
      clearTx(m2);
      spend(m2, "only", 400_000, 1);
      return spendingShape(env(m2), V, RANGE, RATES).then((o2) => {
        // A missing bar reads as "no data"; a zero-height one says "nothing this size".
        assert.equal(o2.buckets.length, 4);
        assert.deepEqual(o2.buckets.map((b) => b.n), [0, 0, 0, 1]);
      });
    });
  } finally { restore(); }
});

test("§SHAPE: the unit is the whole transaction, not a split part", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    spend(m, "big", 300_000, 1);                       // 3000, split three ways
    for (const [i, part] of [100_000, 100_000, 100_000].entries()) {
      m.raw.prepare(
        "INSERT INTO tx_splits (tx_id, category_id, amount, created_at) VALUES (?,?,?,?)",
      ).run("big", 1 + i, -part, 0);
    }
    const o = await spendingShape(env(m), V, RANGE, RATES);
    // One 3 000 cheque at the till, not three 1 000 purchases nobody made. This is the one
    // canonical query that deliberately does not sum EFF_AMOUNT.
    assert.deepEqual(o.buckets.map((b) => b.n), [0, 0, 0, 1]);
    assert.equal(o.buckets[3].spent, 300_000);
  } finally { restore(); }
});

test("§SHAPE: a refund is not a cheque of negative size", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    spend(m, "buy", 30_000, 1);
    // A refund passes SPEND_WHERE on purpose (§REFUND) — it must SUBTRACT from a total. There is
    // simply no size bucket for it.
    m.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
         category_id, hold, is_transfer, created_at)
       VALUES ('ref', 'acc-uah', 'manual', ?, 20000, 980, 'Скасування. Shop', 1, 0, 0, 0)`,
    ).run(NOW - 4 * 86400);
    const o = await spendingShape(env(m), V, RANGE, RATES);
    assert.equal(o.buckets.reduce((s, b) => s + b.n, 0), 1, "only the purchase is a cheque");
    // …and the period total still nets the refund off, as the canon says.
    assert.equal(o.spend, 10_000);
  } finally { restore(); }
});

test("§SHAPE: what falls outside every envelope, and what has no category at all", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    m.raw.prepare("DELETE FROM budgets").run();
    m.raw.prepare("INSERT INTO budgets (category_id, period, amount, currency_code) VALUES (1, 'month', 100000, 980)").run();
    // §BUDGET-ZERO: a zero limit is a real plan («I deliberately spend nothing here»), so this
    // category is BUDGETED — counting it as unplanned would report a decision as its absence.
    m.raw.prepare("INSERT INTO budgets (category_id, period, amount, currency_code) VALUES (2, 'month', 0, 980)").run();
    spend(m, "in-env", 10_000, 1);
    spend(m, "zero-env", 20_000, 2);
    spend(m, "no-env", 40_000, 4);
    spend(m, "no-cat", 30_000, null);

    const o = await spendingShape(env(m), V, RANGE, RATES);

    await t.test("only the category with no budget ROW counts as outside", () => {
      // The uncategorised row is outside too — it is in no envelope by definition.
      assert.equal(o.unbudgeted.spent, 70_000, "40 000 without an envelope + 30 000 with no category");
      assert.equal(o.unbudgeted.n, 2);
    });

    await t.test("unattributed money is counted in MONEY, not in operations", () => {
      assert.equal(o.uncategorised.spent, 30_000);
      assert.equal(o.uncategorised.n, 1);
      assert.equal(o.uncategorised.share_pct, 30, "30 000 of 100 000");
    });
  } finally { restore(); }
});

test("§SHAPE: an empty window states nothing rather than 0%", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    const o = await spendingShape(env(m), V, RANGE, RATES);
    // «0% поза конвертами» over a month with no spending is a claim about planning that the data
    // does not support; null lets the screen say nothing at all.
    assert.equal(o.spend, 0);
    assert.equal(o.unbudgeted.share_pct, null);
    assert.equal(o.uncategorised.share_pct, null);
  } finally { restore(); }
});
