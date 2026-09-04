/**
 * §ENV-PARTS — an envelope says what its month is MADE OF.
 *
 * Two properties are worth a test here, and they fail differently.
 *
 * The first is arithmetic: the three parts must add up to the `spent` the same row already
 * reports. A decomposition that does not add up is worse than none, because it invites the reader
 * to do the addition themselves and get a different answer than the envelope shows — the same
 * defect §BURN-SHAPE guards with `recurring + lumpy === monthly_burn`. It would also fail
 * silently: every individual figure stays plausible.
 *
 * The second is the classification itself. A charge tied to a declared plan is committed; a charge
 * whose merchant has a measured rhythm is rhythmic even though nobody declared it; everything else
 * is discretionary. Getting this wrong does not throw either — it just moves money between two
 * buckets on a screen whose whole purpose is to say which bucket money is in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetStatus } from "../lib/finance/budgets.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const env = (db: MemDb) => testEnv(db) as unknown as Env;
const MULT = "1";
/** Category 1 carries a 15 000 ₴ envelope in the fixture. */
const CAT = 1;
const DAY = 86_400;
/** The fixture freezes at 2026-05-14, so the open month starts on 2026-05-01 Kyiv. */
const MAY_5 = Math.floor(Date.parse("2026-05-05T10:00:00+03:00") / 1000);

let seq = 0;
function charge(
  db: MemDb, merchant: string, amount: number, at: number,
  opts: { plannedId?: number | null; category?: number } = {},
): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
                               category_id, is_transfer, planned_id)
     VALUES (?, 'acc-uah', 'mono', ?, ?, 980, ?, ?, 0, ?)`,
  ).run(`ep-${++seq}`, at, -amount, merchant, opts.category ?? CAT, opts.plannedId ?? null);
}

/** A declared plan, so a charge can be linked to it (§PLAN-LINK). */
function plan(db: MemDb, title: string, amount: number): number {
  const r = db.raw.prepare(
    `INSERT INTO planned_payments (title, kind, period, period_amount, start_date, category_id,
                                   is_active, currency_code, period_count)
     VALUES (?, 'subscription', 'monthly', ?, ?, ?, 1, 980, 1)`,
  ).run(title, amount, MAY_5 - 120 * DAY, CAT);
  return Number(r.lastInsertRowid);
}

/**
 * The envelope BEFORE the charges a scenario adds.
 *
 * The fixture already spends in this category, so asserting absolute totals would be asserting the
 * fixture rather than the split. Every scenario below measures its own delta, which is also the
 * only form that survives someone adding a row to the fixture for an unrelated reason.
 */
async function baseline(db: MemDb) {
  const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
  return row.parts;
}

/** A rhythm the detector will accept: same price, monthly, over several months. */
function rhythm(db: MemDb, merchant: string, amount: number, months: number): void {
  for (let i = months; i >= 1; i--) charge(db, merchant, amount, MAY_5 - i * 30 * DAY);
}

test("§ENV-PARTS: the parts of an envelope's month", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("the three parts add up to the spend the envelope already reports", async () => {
      const db = migratedDb();
      seed(db);
      const netflix = plan(db, "Netflix", 300_00);
      charge(db, "Netflix", 300_00, MAY_5, { plannedId: netflix });
      rhythm(db, "Spotify", 200_00, 4);
      charge(db, "Spotify", 200_00, MAY_5 + DAY);
      charge(db, "Silpo", 850_00, MAY_5 + 2 * DAY);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      const { committed, rhythmic, discretionary } = row.parts;
      assert.equal(
        committed + rhythmic + discretionary, row.spent,
        "the decomposition must equal the number it decomposes",
      );
    });

    await t.test("a plan-linked charge is committed; an undeclared rhythm is still not free", async () => {
      const db = migratedDb();
      seed(db);
      const before = await baseline(db);
      const netflix = plan(db, "Netflix", 300_00);
      charge(db, "Netflix", 300_00, MAY_5, { plannedId: netflix });
      // Four monthly charges at one price, then this month's — a rhythm nobody declared.
      rhythm(db, "Spotify", 200_00, 4);
      charge(db, "Spotify", 200_00, MAY_5 + DAY);
      charge(db, "Silpo", 850_00, MAY_5 + 2 * DAY);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.parts.committed - before.committed, 300_00, "the declared plan");
      assert.equal(row.parts.rhythmic - before.rhythmic, 200_00, "the subscription nobody declared");
      assert.equal(row.parts.discretionary - before.discretionary, 850_00, "the shop");
      // The floor is what recurs whatever is decided for the rest of the month.
      assert.equal(row.floor, row.parts.committed + row.parts.rhythmic);
    });

    await t.test("one visit to a shop is discretionary, however large", async () => {
      const db = migratedDb();
      seed(db);
      const before = await baseline(db);
      charge(db, "Epicentr", 4_000_00, MAY_5);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.parts.rhythmic - before.rhythmic, 0, "a single charge has no rhythm to measure");
      assert.equal(row.parts.discretionary - before.discretionary, 4_000_00);
    });

    await t.test("§BUDGET-REACH mid-month: the floor has already passed the limit", async () => {
      const db = migratedDb();
      seed(db);
      // The envelope is 15 000 ₴; commit more than that to a declared plan on the 5th.
      const rent = plan(db, "Rent", 16_000_00);
      charge(db, "Rent", 16_000_00, MAY_5, { plannedId: rent });

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.floor, 16_000_00);
      assert.ok(row.floor_over_limit, "no restraint for the rest of the month brings this back");
    });

    await t.test("a discretionary overspend is NOT floor_over_limit — restraint still works", async () => {
      const db = migratedDb();
      seed(db);
      charge(db, "Epicentr", 16_000_00, MAY_5);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.ok(row.ratio > 1, "the envelope IS blown");
      assert.equal(row.floor_over_limit, false, "but nothing forces it to happen again");
    });

    await t.test("§BUDGET-ZERO: a zero envelope is never floor_over_limit", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE budgets SET amount = 0 WHERE category_id = ?").run(CAT);
      const rent = plan(db, "Rent", 500_00);
      charge(db, "Rent", 500_00, MAY_5, { plannedId: rent });

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.base_amount, 0);
      assert.equal(row.floor_over_limit, false, "«сюди я свідомо не витрачаю» is a plan, not a miscalculation");
    });
  } finally {
    restore();
  }
});
