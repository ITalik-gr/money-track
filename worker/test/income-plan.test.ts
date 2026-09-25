/**
 * §INCOME-PLAN — expected income must never reach the OUTFLOW selectors (a salary counted as a
 * subscription) nor the canonical income (money not yet arrived).
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
