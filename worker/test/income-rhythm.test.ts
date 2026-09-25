/**
 * §INCOME-RHYTHM and §INCOME-CV.
 *
 * The CV test is the one that failed before this change: `/analytics/income` averaged only the
 * months that HAD income, so a jobless month made income read as MORE stable, and the income card
 * and the health index could disagree about the same money.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { FROZEN_NOW_ISO } from "./fixture.ts";
import { longestGapDays } from "../lib/finance/income-rhythm.ts";
import { incomeCv } from "../lib/finance/flow-series.ts";
import type { IncomeRhythm } from "../../shared/api/insights.ts";
import type { IncomeAnalytics } from "../../shared/api/analytics.ts";

const DAY = 86400;

async function get<T>(db: MemDb, path: string): Promise<T> {
  const res = await api.request(path, { method: "GET" }, testEnv(db));
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  return await res.json() as T;
}

/** Six complete months before the frozen now; income on the 5th except in `skip` (months back). */
function ledger(skip: number[]): MemDb {
  const db = migratedDb();
  db.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('acc1', 'black', 'Картка', 980, 1000000, 0, 1, 0)`,
  ).run();
  const inc = (db.raw.prepare("SELECT id FROM categories WHERE is_income = 1 LIMIT 1").get() as { id: number }).id;
  const now = Date.parse(FROZEN_NOW_ISO);
  // The ledger starts on the 1st of the first month, so every month is fully covered.
  const d0 = new Date(now);
  const first = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 6, 1, 10) / 1000;
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, hold, is_transfer)
     VALUES ('seed', 'acc1', 'mono', ?, -100, 980, 'M', NULL, 0, 0)`,
  ).run(first);
  for (let k = 6; k >= 1; k--) {
    if (skip.includes(k)) continue;
    const at = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - k, 5, 10) / 1000;
    db.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, hold, is_transfer)
       VALUES (?, 'acc1', 'mono', ?, 4000000, 980, 'Employer', ?, 0, 0)`,
    ).run(`inc${k}`, at, inc);
  }
  return db;
}

test("incomeCv: zero-filled, null without a spread or without income", () => {
  assert.equal(incomeCv([100]), null);
  assert.equal(incomeCv([0, 0, 0]), null);
  assert.equal(incomeCv([100, 100, 100]), 0);
  assert.ok(incomeCv([100, 0, 100])! > 0.5);
});

test("longestGapDays counts the wait that is still running", () => {
  assert.equal(longestGapDays([], 100 * DAY), null);
  assert.equal(longestGapDays([0, 30 * DAY, 90 * DAY], 100 * DAY), 60);
  assert.equal(longestGapDays([0, 10 * DAY], 80 * DAY), 70, "70 days since the last one is the longest");
});

test("§INCOME-CV: a jobless month makes income LESS stable — on the income card and in the rhythm alike", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const steady = ledger([]);
    const holey = ledger([3]);   // nothing three months ago
    const [a, b] = await Promise.all([
      get<IncomeAnalytics>(steady, "/analytics/income"),
      get<IncomeAnalytics>(holey, "/analytics/income"),
    ]);
    assert.equal(a.stability.cv_pct, 0);
    assert.ok(b.stability.cv_pct != null && b.stability.cv_pct > 30, `holey cv ${b.stability.cv_pct}`);
    const r = await get<IncomeRhythm>(holey, "/insights/income-rhythm");
    assert.equal(r.cv_pct, b.stability.cv_pct, "one definition, one number");
    assert.ok(r.longest_gap_days! >= 55, `the hole shows as a gap: ${r.longest_gap_days}`);
  } finally { restore(); }
});
