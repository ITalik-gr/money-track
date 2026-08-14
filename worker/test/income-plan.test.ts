/**
 * §INCOME-PLAN — expected inflow, and the two ways it must not leak.
 *
 * The feature is one schedule reused with the sign flipped, so almost nothing here tests the
 * schedule itself (`subscriptions.test.ts` already does). What it tests is CONTAINMENT, because
 * both failure modes are silent and both corrupt numbers people act on:
 *
 *   1. an income plan reaching the OUTFLOW selectors would count a salary as a subscription —
 *      inflating the monthly burden, the liquidity gap and "скоро спишеться", all of which would
 *      still look entirely reasonable on screen;
 *   2. expected income reaching the canonical `income` would mean the app quotes money that has not
 *      arrived as money you have, which is the one mistake a finance app must never make.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { incomeOutlook } from "../lib/finance/income.ts";
import * as planningRepo from "../repo/planning.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const env = (db: MemDb) => testEnv(db) as unknown as Env;
const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);   // 2026-05-14
const DAY = 86400;

/** An income plan paying `amount` monthly, first occurrence on `startDay` of the current month. */
function incomePlan(
  db: MemDb, title: string, amount: number, startDay: number,
  opts: { varies?: boolean; currency?: number } = {},
): void {
  const start = Math.floor(new Date(`2026-05-${String(startDay).padStart(2, "0")}T09:00:00.000Z`).getTime() / 1000);
  db.raw.prepare(
    `INSERT INTO planned_payments
       (title, kind, period_amount, period, period_count, start_date, currency_code, amount_varies, is_active)
     VALUES (?, 'income', ?, 'month', 1, ?, ?, ?, 1)`,
  ).run(title, amount, start, opts.currency ?? 980, opts.varies ? 1 : 0);
}

test("§INCOME-PLAN: an income plan never reaches the OUTFLOW schedule", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("the outflow selectors exclude it; the income selector finds it", async () => {
      const db = migratedDb();
      seed(db);
      const before = (await planningRepo.activeWithTitles(db as unknown as never)).length;
      incomePlan(db, "Зарплата", 40_000_00, 25);

      // The three selectors every expense consumer goes through — subscription burden, the
      // cashflow calendar, the liquidity gap, "скоро спишеться", the advisor's snapshot.
      assert.equal((await planningRepo.activeWithTitles(db as unknown as never)).length, before);
      assert.equal((await planningRepo.activeForSchedule(db as unknown as never)).length, before);
      assert.equal((await planningRepo.activeWithCategory(db as unknown as never)).length, before);
      // …and exactly one selector does see it.
      assert.equal((await planningRepo.activeIncomePlans(db as unknown as never)).length, 1);
    });

    await t.test("expected income is NOT added to the canonical `received`", async () => {
      const db = migratedDb();
      seed(db);
      const withoutPlan = (await incomeOutlook(env(db), NOW)).received;
      incomePlan(db, "Інвойс", 50_000_00, 25);
      const outlook = await incomeOutlook(env(db), NOW);

      // `received` is the canon and answers only "what actually arrived". A plan must not move it.
      assert.equal(outlook.received, withoutPlan);
      assert.equal(outlook.expected_remaining, 50_000_00, "the 25th is still ahead of the 14th");
    });
  } finally {
    restore();
  }
});

test("§INCOME-PLAN: late money is visible without being invented", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("due before now and not received → overdue, not 'expected'", async () => {
      const db = migratedDb();
      seed(db);
      // The fixture's May income is far below this, so most of it is genuinely missing.
      incomePlan(db, "Ретейнер", 500_000_00, 5);
      const o = await incomeOutlook(env(db), NOW);

      assert.equal(o.expected_remaining, 0, "the 5th has passed — nothing is still 'coming'");
      assert.equal(o.expected_to_date, 500_000_00);
      assert.equal(o.overdue, 500_000_00 - o.received);
      assert.ok(o.overdue > 0);
    });

    await t.test("money that arrived closes the gap, whatever its size or source", async () => {
      const db = migratedDb();
      seed(db);
      // Expected 1 000 ₴ on the 5th; the fixture's actual May income already exceeds that.
      incomePlan(db, "Дрібний інвойс", 1_000_00, 5);
      const o = await incomeOutlook(env(db), NOW);
      assert.ok(o.received > 1_000_00);
      // This is the whole reason lateness is a comparison of TOTALS rather than a per-invoice
      // matcher: income is neither the same size nor on time, so a different amount — or an
      // entirely unplanned payment — simply means the money came, which is what happened in life.
      assert.equal(o.overdue, 0);
    });

    await t.test("a varying plan marks the totals as estimates", async () => {
      const db = migratedDb();
      seed(db);
      incomePlan(db, "Фікс", 10_000_00, 25);
      let o = await incomeOutlook(env(db), NOW);
      assert.equal(o.estimated, false);

      incomePlan(db, "Плаваючий інвойс", 20_000_00, 26, { varies: true });
      o = await incomeOutlook(env(db), NOW);
      // ONE uncertain plan makes the TOTAL uncertain — a sum presented as exact because the other
      // contributor happened to be fixed would be worse than no sum.
      assert.equal(o.estimated, true);
      assert.equal(o.expected_remaining, 30_000_00);
      assert.equal(o.items.length, 2);
    });

    await t.test("a foreign-currency invoice is converted, like every other plan (§CUR-PLAN)", async () => {
      const db = migratedDb();
      seed(db);
      incomePlan(db, "USD retainer", 1_000_00, 25, { currency: 840 });
      const o = await incomeOutlook(env(db), NOW);
      // Never the raw 1 000: a $1 000 invoice is not 1 000 ₴, and this is the exact bug §CUR-PLAN
      // was written about on the expense side.
      assert.ok(o.expected_remaining > 1_000_00, `expected ₴ conversion, got ${o.expected_remaining}`);
    });
  } finally {
    restore();
  }
});

test("§INCOME-PLAN: an account with no income plans is unchanged", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const o = await incomeOutlook(env(db), NOW);
    // The feature must be inert until used: no plans means no expectation, no overdue, no estimate
    // flag — and `received` still equal to the canon.
    assert.equal(o.expected_remaining, 0);
    assert.equal(o.expected_to_date, 0);
    assert.equal(o.overdue, 0);
    assert.equal(o.estimated, false);
    assert.deepEqual(o.items, []);
    assert.ok(o.received >= 0);
  } finally {
    restore();
  }
});

test("§INCOME-PLAN: a weekly plan yields several occurrences, and only the future ones remain", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const start = NOW - 10 * DAY;
    db.raw.prepare(
      `INSERT INTO planned_payments
         (title, kind, period_amount, period, period_count, start_date, currency_code, is_active)
       VALUES ('Погодинний', 'income', 5000, 'week', 1, ?, 980, 1)`,
    ).run(start);

    const o = await incomeOutlook(env(db), NOW);
    // The split between "already due" and "still coming" is what makes `overdue` meaningful; a
    // single total over the whole month would hide which side of today each payment sits on.
    assert.ok(o.expected_to_date > 0, "occurrences before today");
    assert.ok(o.expected_remaining > 0, "and occurrences after it");
    assert.ok(o.items.every((i) => i.at > NOW), "`items` lists only what is still ahead");
  } finally {
    restore();
  }
});
