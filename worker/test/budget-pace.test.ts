/**
 * §BUDGET-PACE — «за поточним темпом» has to be about the current pace.
 *
 * The bug this pins arrived in the owner's feed as two events in one morning: «„Здоров'я“ іде на
 * 227% бюджету — За поточним темпом місяць закриється на 682 ₴ при ліміті 300 ₴. Витрачено поки
 * що 0 ₴». Nothing in it was miscomputed. The spend really was 0, the month really was the
 * calendar month, and 682 really is what `projectSpend` returns — because on the 10th the
 * projection is weighted overwhelmingly towards the category's canonical LEVEL, and that level is
 * 1 400 ₴ against a 300 ₴ limit.
 *
 * So the failure is not arithmetic and no assertion on a total would have caught it: the sentence
 * named a quantity (the pace) that the gate did not look at. Both scenarios below are about that
 * one word, and both fail silently without the test — the wrong one by sending a plausible
 * notification, the right one by sending nothing at all.
 *
 * ⚠️ An envelope whose LEVEL sits above its limit is a real finding, and the app already reports
 * it twice (§BUDGET-REACH `unreachable`, §ENV-PARTS `floor_over_limit`). The last assertion holds
 * that line: silencing the pace warning must not silence those.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetStatus } from "../lib/finance/budgets.ts";
import { draftBudgetForecast } from "../lib/messaging/drafts-budget.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const env = (db: MemDb) => testEnv(db) as unknown as Env;
const MULT = "1";
const DAY = 86_400;
/** The fixture freezes at 2026-05-14 Kyiv — past the 10th, so the forecast gate is open. */
const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
const MAY_1 = Math.floor(Date.parse("2026-05-01T00:00:00+03:00") / 1000);

let seq = 0;
function charge(db: MemDb, categoryId: number, amount: number, at: number): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
                               category_id, is_transfer)
     VALUES (?, 'acc-uah', 'mono', ?, ?, 980, ?, ?, 0)`,
  ).run(`bp-${++seq}`, at, -amount, `Shop ${seq}`, categoryId);
}

/**
 * A category nobody in the fixture spends in, given a small envelope and a HISTORY that dwarfs it.
 *
 * Picked from the data rather than hard-coded for the same reason §BUDGET-ZERO's quiet category
 * is: a fixture that grows a transaction in the chosen category would otherwise turn this into a
 * test of something else, while still passing.
 */
function envelopeWithBigHistory(db: MemDb, limit: number): number {
  const quiet = db.raw.prepare(
    `SELECT id FROM categories
     WHERE is_income = 0 AND parent_id IS NULL
       AND id NOT IN (SELECT COALESCE(category_id, -1) FROM transactions)
     ORDER BY id LIMIT 1`,
  ).get() as { id: number };
  db.raw.prepare(
    "INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, 'month', ?, 980, 0)",
  ).run(quiet.id, limit);
  // The whole six-month level window at ~1 400 ₴, spread across days so no month reads as a
  // single lump — a lump is deliberately never extrapolated, which would make the scenario pass
  // for the wrong reason.
  for (let m = 1; m <= 6; m++) {
    for (let i = 0; i < 4; i++) charge(db, quiet.id, 350_00, MAY_1 - m * 30 * DAY + i * 3 * DAY);
  }
  return quiet.id;
}

test("§BUDGET-PACE: a forecast warning is about the pace, not about history", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("nothing spent this month → no pace, and no warning", async () => {
      const db = migratedDb();
      seed(db);
      const cat = envelopeWithBigHistory(db, 300_00);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === cat)!;
      assert.equal(row.spent, 0, "the scenario is an untouched envelope");
      assert.equal(row.pace_ratio, 0, "no spending is no pace, whatever history says");
      // The blend still projects well over the limit — that is the estimate, and it is allowed to
      // exist. What it may not do is speak in the feed as if it were a rate.
      assert.ok(row.projected_ratio > 1.1, "the blend does head over — this is the trap");

      const drafts = await draftBudgetForecast(env(db), NOW);
      assert.equal(
        drafts.find((d) => d.entity_id === String(cat)), undefined,
        "«за поточним темпом … витрачено 0 ₴» is a sentence about nothing",
      );
    });

    await t.test("spending that really is heading over still speaks", async () => {
      const db = migratedDb();
      seed(db);
      const cat = envelopeWithBigHistory(db, 300_00);
      // 180 ₴ over the first fortnight against a 300 ₴ month: 60% of the limit gone in 44% of the
      // days. Four charges, none dominant — a single large one would be a lump, which the forecast
      // deliberately never extrapolates, and the scenario would then pass for the wrong reason.
      for (let i = 0; i < 4; i++) charge(db, cat, 45_00, MAY_1 + (i * 3 + 1) * DAY);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === cat)!;
      assert.ok(row.pace_ratio >= 1, "the pace alone overruns the limit");
      assert.ok(row.ratio < 0.9, "and `draftBudgets` has not taken the case over yet");

      const draft = (await draftBudgetForecast(env(db), NOW)).find((d) => d.entity_id === String(cat));
      assert.ok(draft, "this is exactly the warning the feature exists to send");
      assert.equal(draft!.tkey, "budget_forecast");
    });

    await t.test("the unreachable limit is still reported — just not as a pace", async () => {
      const db = migratedDb();
      seed(db);
      const cat = envelopeWithBigHistory(db, 300_00);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === cat)!;
      assert.equal(
        row.unreachable, true,
        "§BUDGET-REACH: a 300 ₴ limit on a 1 400 ₴ category is the finding — in its own voice",
      );
    });
  } finally {
    restore();
  }
});
