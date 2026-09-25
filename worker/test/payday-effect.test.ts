/**
 * §PAYDAY-EFFECT — built on two ledgers, because the seeded fixture says nothing either way: one
 * that CONTAINS the effect (money goes in the week after payday) and one that does not (spending is
 * spread evenly). A threshold that fires on both, or on neither, is the failure this pins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { FROZEN_NOW_ISO } from "./fixture.ts";
import { paydayEffect, receiptEvents } from "../lib/finance/payday-effect.ts";
import type { Env } from "../env.ts";

const RATES = { "980": 1 };
const DAY = 86400;

function ledger(spend: (monthStart: number) => { at: number; minor: number }[]): MemDb {
  const db = migratedDb();
  db.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('acc1', 'black', 'Картка', 980, 1000000, 0, 1, 0)`,
  ).run();
  const incomeCat = (db.raw.prepare("SELECT id FROM categories WHERE is_income = 1 LIMIT 1").get() as { id: number }).id;
  const spendCat = (db.raw.prepare(
    `SELECT id FROM categories WHERE COALESCE(is_income, 0) = 0 AND parent_id IS NULL AND id <> 13
       AND COALESCE(importance, 'discretionary') <> 'essential' LIMIT 1`,
  ).get() as { id: number }).id;
  const put = (id: string, at: number, amount: number, cat: number) => db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, hold, is_transfer)
     VALUES (?, 'acc1', 'mono', ?, ?, 980, 'M', ?, 0, 0)`,
  ).run(id, at, amount, cat);
  const now = Date.parse(FROZEN_NOW_ISO);
  for (let k = 6; k >= 1; k--) {
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1, 10) / 1000;
    put(`inc${k}`, monthStart + 4 * DAY, 40_000_00, incomeCat);           // payday on the 5th
    spend(monthStart).forEach((s, i) => put(`sp${k}-${i}`, s.at, -s.minor, spendCat));
  }
  return db;
}

test("receiptEvents: a salary and its bonus two days later are ONE arrival", () => {
  assert.deepEqual(receiptEvents([10 * DAY, 12 * DAY, 40 * DAY]), [10 * DAY, 40 * DAY]);
  assert.deepEqual(receiptEvents([40 * DAY, 10 * DAY]), [10 * DAY, 40 * DAY], "sorted first");
});

test("§PAYDAY-EFFECT: money going in the week after payday is measured as such", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // 5 × 1 000 ₴ in the five days after payday, then one 500 ₴ purchase late in the month.
    const db = ledger((m) => [
      ...[5, 6, 7, 8, 9].map((d) => ({ at: m + d * DAY, minor: 1_000_00 })),
      { at: m + 20 * DAY, minor: 500_00 },
    ]);
    const r = await paydayEffect(testEnv(db) as unknown as Env, RATES);
    assert.ok(r.events >= 3, `events: ${r.events}`);
    assert.ok(r.ratio != null && r.ratio > 2, `ratio: ${r.ratio}`);
  } finally { restore(); }
});

test("§PAYDAY-EFFECT: evenly spread spending shows no effect", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = ledger((m) => Array.from({ length: 10 }, (_, i) => ({ at: m + (i * 3 + 1) * DAY, minor: 300_00 })));
    const r = await paydayEffect(testEnv(db) as unknown as Env, RATES);
    assert.ok(r.ratio != null && r.ratio > 0.7 && r.ratio < 1.4, `ratio: ${r.ratio}`);
  } finally { restore(); }
});

test("§PAYDAY-EFFECT: no income, no answer — never a confident 0", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const r = await paydayEffect(testEnv(migratedDb()) as unknown as Env, RATES);
    assert.deepEqual(r, { events: 0, typical_week: null, after_week: null, ratio: null });
  } finally { restore(); }
});
