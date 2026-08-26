/**
 * §LEVEL-WINDOW — the canonical monthly level divided by months that never happened.
 *
 * Found on 2026-08-27 during the §0.2 pass, by checking the app's own numbers against an
 * independent path (the MCP tools) on the owner's real ledger:
 *
 *   • the ledger's first operation is in APRIL 2026; `categoryMonthlyLevels` uses a six-month
 *     window, February–July, and divided by six unconditionally. February and March did not exist
 *     for this user, so every level was 1.5× too low;
 *   • «Комуналка і звʼязок» levelled at 1 087 against real months of 1 246 / 1 285 / 2 531 / 1 458
 *     — a figure it had never once achieved. The auto-budget then set the envelope AT that level,
 *     and the app reported it 153% over, every month, for an arithmetically unreachable target;
 *   • `sumLevels` IS the canonical burn, so runway — the number that matters most to someone out
 *     of work — was systematically optimistic.
 *
 * What is pinned here is the DENOMINATOR, in both directions: a zero month inside the ledger still
 * counts (spending nothing on education in April is real data), a month before the ledger does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { categoryMonthlyLevels, sumLevels } from "../lib/finance/levels.ts";
import { localMonthStart } from "../lib/finance/time.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);
const env = (m: MemDb) => testEnv(m) as unknown as Env;
const MULT = "1";

function clearTx(m: MemDb) {
  for (const t of ["tx_splits", "tx_reimbursements", "ai_changes", "transactions"]) {
    m.raw.prepare(`DELETE FROM ${t}`).run();
  }
}

/** One expense in the month `back` whole months before the current one, early in it. */
function spendInMonth(m: MemDb, id: string, back: number, amount: number, category = 7) {
  const at = localMonthStart(NOW, -back) + 2 * 86400 + 12 * 3600;   // the 3rd — inside the grace week
  m.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
       category_id, hold, is_transfer, created_at)
     VALUES (?, 'acc-uah', 'manual', ?, ?, 980, 'Кабельне', ?, 0, 0, 0)`,
  ).run(id, at, -amount, category);
}

test("§LEVEL-WINDOW: months before the first operation are not months of zero spending", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    // The owner's shape: a six-month window, and the ledger starts four months in.
    spendInMonth(m, "u1", 4, 124_600);
    spendInMonth(m, "u2", 3, 128_500);
    spendInMonth(m, "u3", 2, 253_100);
    spendInMonth(m, "u4", 1, 145_800);
    const levels = await categoryMonthlyLevels(env(m), MULT, { now: NOW });
    const lv = levels.get(7)!;

    await t.test("the level is the average over the months that existed", () => {
      const total = 124_600 + 128_500 + 253_100 + 145_800;
      assert.equal(lv.mean, Math.round(total / 4), "four months, not six");
      // The figure that shipped: dividing by the whole window gave 108 666 — below every single
      // month the category ever had.
      assert.notEqual(lv.mean, Math.round(total / 6));
    });

    await t.test("and it is not below every month it was averaged from", () => {
      // The property that makes it usable as a budget: an average of four figures cannot sit under
      // the smallest of them. The shipped level did, which is why the envelope could never be met.
      assert.ok(lv.level >= 124_600, `level ${lv.level} must not be under the cheapest month`);
    });
  } finally { restore(); }
});

test("§LEVEL-WINDOW: a quiet month INSIDE the ledger still counts", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    // The ledger starts six months back, so the whole window is covered…
    spendInMonth(m, "old", 6, 100_000, 1);
    // …and this category was used in only two of those months.
    spendInMonth(m, "e1", 4, 498_200);
    spendInMonth(m, "e2", 3, 110_400);
    const levels = await categoryMonthlyLevels(env(m), MULT, { now: NOW });

    await t.test("the denominator is the ledger, not the category's activity", () => {
      // Dividing by ACTIVE months instead would report a yearly insurance payment as a monthly
      // cost — the opposite error, and a much larger one.
      const lv = levels.get(19) ?? levels.get(7)!;
      assert.equal(lv.mean, Math.round((498_200 + 110_400) / 6), "six covered months");
      assert.equal(lv.active_months, 2, "…while the activity itself is still reported");
    });
  } finally { restore(); }
});

test("§LEVEL-WINDOW: a ledger that starts mid-month drops that partial month", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    // Two full months, plus a stub of a third that began on the 25th. Counting that stub as a
    // month is the same defect the CURRENT month is already excluded for, mirrored.
    const at = localMonthStart(NOW, -3) + 24 * 86400;
    m.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
         category_id, hold, is_transfer, created_at)
       VALUES ('part', 'acc-uah', 'manual', ?, -20000, 980, 'Кабельне', 7, 0, 0, 0)`,
    ).run(at);
    spendInMonth(m, "f1", 2, 200_000);
    spendInMonth(m, "f2", 1, 200_000);

    const lv = (await categoryMonthlyLevels(env(m), MULT, { now: NOW })).get(7)!;
    await t.test("the partial month is out of both the sum and the divisor", () => {
      assert.equal(lv.mean, 200_000, "two whole months of 2 000, and nothing else");
    });
  } finally { restore(); }
});

test("§LEVEL-WINDOW: the burn moves with it, and so does the runway", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    clearTx(m);
    spendInMonth(m, "b1", 2, 300_000);
    spendInMonth(m, "b2", 1, 300_000);
    const burn = sumLevels(await categoryMonthlyLevels(env(m), MULT, { now: NOW }));
    // Two months of 3 000 is a burn of 3 000 — not 1 000, which is what dividing by the six-month
    // window produced. Runway is cushion ÷ burn, so a burn a third of the truth is a runway three
    // times too long, for the person least able to afford that error.
    assert.equal(burn, 300_000);
  } finally { restore(); }
});
