/**
 * §SUB-PAGE — one subscription, answered the way a category is.
 *
 * A plan was a row on a list, and the questions people actually have about a subscription had no
 * home: what it has already cost, whether it got more expensive, whether it is billed as often as
 * the plan claims. The last one is the reason this file pins the CADENCE: a plan saying "monthly"
 * that is charged every 14 days is a real and invisible thing, and it is invisible precisely
 * because both the plan and each individual charge look correct on their own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { subscriptionOverview } from "../lib/finance/subscription-overview.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);
const env = (m: MemDb) => testEnv(m) as unknown as Env;

/** A monthly plan of 300 ₴, plus `charges` real charges spaced `everyDays` apart. */
function seedPlan(m: MemDb, opts: { everyDays: number; amounts: number[]; endDate?: number }) {
  m.raw.prepare(
    `INSERT INTO planned_payments (id, title, kind, period_amount, currency_code, period, period_count,
       start_date, end_date, category_id, is_active)
     VALUES (7, 'Netflix', 'subscription', 30000, 980, 'month', 1, ?, ?, 1, 1)`,
  ).run(NOW - 200 * 86400, opts.endDate ?? null);
  opts.amounts.forEach((amt, i) => {
    m.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
         category_id, planned_id, hold, is_transfer, created_at)
       VALUES (?, 'acc-uah', 'mono', ?, ?, 980, 'Netflix UA', 1, 7, 0, 0, 0)`,
    ).run(`nf-${i}`, NOW - (opts.amounts.length - 1 - i) * opts.everyDays * 86400, -amt);
  });
}

test("§SUB-PAGE: what the subscription has already cost, and whether it grew", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    seedPlan(m, { everyDays: 30, amounts: [30000, 30000, 34500] });
    const o = (await subscriptionOverview(env(m), 7, NOW))!;

    await t.test("the total is every charge, not the plan multiplied by a guess", async () => {
      assert.equal(o.actual.n, 3);
      assert.equal(o.actual.total_base, 94500, "300 + 300 + 345");
      assert.equal(o.actual.avg_base, 31500);
    });

    await t.test("the price rise is measured against the DECLARED amount", async () => {
      // 345 against a plan of 300 — and both in the billed currency, because an exchange-rate move
      // is not the biller charging more.
      assert.equal(o.actual.last_amount, 34500);
      assert.equal(o.actual.price_change_pct, 15);
    });

    await t.test("a year of it, from the canonical monthly burden", async () => {
      assert.equal(o.plan.monthly_base, 30000);
      assert.equal(o.annual_base, 360000);
    });

    await t.test("the charges come back newest first, for the chart and the list", async () => {
      assert.equal(o.charges.length, 3);
      assert.ok(o.charges[0].time > o.charges[2].time);
      assert.equal(o.charges[0].amount, 34500);
    });
  } finally { restore(); }
});

test("§SUB-PAGE: the REAL cadence, which is the thing nobody could see", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("a monthly plan billed every 14 days says so", async () => {
      const m = migratedDb();
      seed(m);
      seedPlan(m, { everyDays: 14, amounts: [30000, 30000, 30000, 30000] });
      const o = (await subscriptionOverview(env(m), 7, NOW))!;
      assert.equal(o.actual.real_interval_days, 14);
      assert.equal(o.actual.declared_interval_days, 30, "«month» as the plan declares it");
    });

    await t.test("under two charges there is no interval to measure, and none is invented", async () => {
      const m = migratedDb();
      seed(m);
      seedPlan(m, { everyDays: 30, amounts: [30000] });
      const o = (await subscriptionOverview(env(m), 7, NOW))!;
      assert.equal(o.actual.real_interval_days, null);
    });
  } finally { restore(); }
});

test("§SUB-PAGE: a plan that has ended has no next charge", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    seedPlan(m, { everyDays: 30, amounts: [30000], endDate: NOW - 10 * 86400 });
    const o = (await subscriptionOverview(env(m), 7, NOW))!;
    // Printing the date it WOULD have fallen on is the app arguing with a decision already made.
    assert.equal(o.next_charge, null);
  } finally { restore(); }
});

test("§SUB-PAGE: an unknown id is not an empty page", async () => {
  const m = migratedDb();
  seed(m);
  // `null`, so the route can answer 404. A zero-filled overview would read as a subscription that
  // exists and costs nothing.
  assert.equal(await subscriptionOverview(env(m), 999, NOW), null);
});

test("§SUB-PAGE: a subscription with no linked charges says nothing, rather than guessing", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    seedPlan(m, { everyDays: 30, amounts: [] });
    const o = (await subscriptionOverview(env(m), 7, NOW))!;
    assert.equal(o.actual.n, 0);
    assert.equal(o.actual.total_base, 0);
    assert.equal(o.actual.avg_base, null, "an average of nothing is not zero");
    assert.equal(o.actual.price_change_pct, null);
    // The burden is still known — it comes from the plan, not from the history.
    assert.equal(o.plan.monthly_base, 30000);
  } finally { restore(); }
});
