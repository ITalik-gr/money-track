/**
 * §BUDGET-MEMORY — the envelope remembers the month before it.
 *
 * These scenarios exist because the feature has two failure modes and BOTH are silent. If the
 * carry is wrong, every screen still renders a plausible envelope with plausible numbers — the
 * only symptom is that the limit is not the one the user agreed to. And if the month never closes,
 * nothing breaks either: the envelope just quietly stops carrying anything, forever, while looking
 * exactly like an envelope with nothing to carry.
 *
 * The history is also what the feature is FOR (the owner picked it to answer "am I getting better
 * at this"), so a row that lies about a closed month is worse than no row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetStatus, closeBudgetMonths } from "../lib/finance/budgets.ts";
import * as budgetsRepo from "../repo/budgets.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const env = (db: MemDb) => testEnv(db) as unknown as Env;
/** The fixture's rates give a hryvnia-only multiplier; every amount below is already ₴. */
const MULT = "1";

/** Category 1 carries a 15 000 ₴ envelope in the fixture; 2 carries 1 000 ₴. */
const CAT = 1;

function setRollover(db: MemDb, categoryId: number, on: boolean): void {
  db.raw.prepare("UPDATE budgets SET rollover = ? WHERE category_id = ?").run(on ? 1 : 0, categoryId);
}

/** A closed month, written straight in — the chain's input, independent of the closer. */
function closed(
  db: MemDb, ym: string, categoryId: number,
  limit: number, spent: number, carryIn = 0,
): void {
  db.raw.prepare(
    `INSERT INTO budget_months (ym, category_id, limit_minor, carry_in_minor, spent_minor, closed_at)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(ym, categoryId, limit, carryIn, spent);
}

test("§BUDGET-MEMORY: the carry a closed month hands to the one now open", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);   // 2026-05-14 → the month that just closed is 2026-04
  try {
    await t.test("underspending carries FORWARD, and the envelope says where it came from", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      closed(db, "2026-04", CAT, 15_000_00, 12_000_00);   // 3 000 ₴ left over

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.base_amount, 15_000_00);
      assert.equal(row.carried, 3_000_00);
      // The EFFECTIVE limit is what every consumer reads, so the carry cannot be forgotten by one
      // of them — the exact defect this replaced (the Plan page added it, the grid did not).
      assert.equal(row.amount, 18_000_00);
      assert.ok(Math.abs(row.ratio - row.spent / 18_000_00) < 1e-9);
    });

    await t.test("OVERspending carries too — the asymmetry that made the envelope a game", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      closed(db, "2026-04", CAT, 15_000_00, 17_500_00);   // 2 500 ₴ over

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      // The old client-side version was `max(0, limit − spent)`: saving was rewarded, overspending
      // cost nothing, and an envelope you cannot lose is not a constraint.
      assert.equal(row.carried, -2_500_00);
      assert.equal(row.amount, 12_500_00);
    });

    await t.test("the carry is clamped to ±the base limit, in both directions", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      // A month that spent nothing at all AND arrived carrying a full extra limit: 30 000 ₴ of
      // slack would be available if nothing capped it.
      closed(db, "2026-04", CAT, 15_000_00, 0, 15_000_00);
      let row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.carried, 15_000_00, "capped at one month of slack, not two");

      const db2 = migratedDb();
      seed(db2);
      setRollover(db2, CAT, true);
      closed(db2, "2026-04", CAT, 15_000_00, 60_000_00);   // spent four times the limit
      row = (await budgetStatus(env(db2), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.carried, -15_000_00);
      // Zero available, and the ratio still divides rather than returning Infinity — which would
      // serialise to `null` and render as a blank envelope.
      assert.equal(row.amount, 0);
      assert.ok(Number.isFinite(row.ratio));
    });

    await t.test("rollover OFF carries nothing, however the month closed", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, false);
      closed(db, "2026-04", CAT, 15_000_00, 1_000_00);

      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.carried, 0);
      assert.equal(row.amount, row.base_amount);
      assert.equal(row.rollover, false);
    });

    await t.test("no closed month means NO carry — never one invented from the transactions", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      // No `budget_months` row. The spending is all still there and a carry could be derived from
      // it, but only against TODAY's limit — so every edit of the limit would rewrite what April
      // supposedly handed over.
      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.carried, 0);
      assert.equal(row.amount, row.base_amount);
    });

    await t.test("a month two back is NOT the source — only the one that just closed", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      closed(db, "2026-03", CAT, 15_000_00, 1_000_00);   // huge leftover, but stale
      const row = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.equal(row.carried, 0, "March cannot reach May; April is the only link");
    });
  } finally {
    restore();
  }
});

test("§BUDGET-MEMORY: closing a month", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("writes one row per envelope, for the month that just ended", async () => {
      const db = migratedDb();
      seed(db);
      const r = await closeBudgetMonths(env(db), MULT);
      assert.equal(r.ym, "2026-04");
      assert.equal(r.closed, 2, "the fixture has two monthly envelopes");

      const rows = await budgetsRepo.closedMonth(db as unknown as never, "2026-04");
      const m = rows.get(CAT)!;
      assert.equal(m.limit_minor, 15_000_00);
      // The spend is the canonical one, so the stored history cannot disagree with the screens.
      assert.ok(m.spent_minor >= 0);
    });

    await t.test("running it again changes NOTHING — the daily pass is idempotent", async () => {
      const db = migratedDb();
      seed(db);
      await closeBudgetMonths(env(db), MULT);
      const before = (await budgetsRepo.closedMonth(db as unknown as never, "2026-04")).get(CAT)!;

      // Spending appears afterwards, as it does when an old row is re-categorised months later.
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, created_at)
         VALUES ('late-april', 'acc-uah', 'manual', ?, -900000, 980, 1, 0)`,
      ).run(Math.floor(new Date("2026-04-20T10:00:00.000Z").getTime() / 1000));

      const second = await closeBudgetMonths(env(db), MULT);
      assert.equal(second.closed, 0, "already closed → no work at all");
      const after = (await budgetsRepo.closedMonth(db as unknown as never, "2026-04")).get(CAT)!;
      // A closed month is a RECORD, not a live query: the carry chain is built on this number, and
      // a figure that keeps moving would silently restate a limit the user already lived with.
      assert.equal(after.spent_minor, before.spent_minor);
    });

    await t.test("the close carries the chain forward, and respects the rollover flag", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      closed(db, "2026-03", CAT, 15_000_00, 14_000_00);   // 1 000 ₴ into April

      await closeBudgetMonths(env(db), MULT);
      const april = (await budgetsRepo.closedMonth(db as unknown as never, "2026-04")).get(CAT)!;
      assert.equal(april.carry_in_minor, 1_000_00);

      // …and with the flag off, the same March row hands over nothing.
      const db2 = migratedDb();
      seed(db2);
      setRollover(db2, CAT, false);
      closed(db2, "2026-03", CAT, 15_000_00, 14_000_00);
      await closeBudgetMonths(env(db2), MULT);
      const april2 = (await budgetsRepo.closedMonth(db2 as unknown as never, "2026-04")).get(CAT)!;
      assert.equal(april2.carry_in_minor, 0);
    });

    await t.test("the track record counts a month as blown against its EFFECTIVE limit", async () => {
      const db = migratedDb();
      seed(db);
      // 15 000 limit, 1 000 carried in, 15 500 spent — over the base limit, INSIDE the effective
      // one. Counting it as a miss would punish the user for money the app itself handed them.
      closed(db, "2026-03", CAT, 15_000_00, 15_500_00, 1_000_00);
      closed(db, "2026-04", CAT, 15_000_00, 20_000_00);

      const rec = (await budgetsRepo.trackRecord(db as unknown as never, "2026-01")).get(CAT)!;
      assert.equal(rec.closed, 2);
      assert.equal(rec.over, 1, "only April; March stayed inside its effective limit");
    });

    await t.test("applying an auto-budget PRESERVES the rollover flag", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);

      await budgetsRepo.setMonthlyBatch(db as unknown as never, [{ category_id: CAT, amount: 9_000_00 }]);

      const env = (await budgetsRepo.monthlyEnvelopes(db as unknown as never)).get(CAT)!;
      assert.equal(env.amount, 9_000_00, "the limit is what the user asked to change");
      // …and the setting they did NOT ask to change is still there. The batch used to write a
      // literal 0, so accepting a proposal quietly switched §BUDGET-MEMORY off.
      assert.equal(env.rollover, true);
    });

    await t.test("history reads oldest first and never back-fills months it did not measure", async () => {
      const db = migratedDb();
      seed(db);
      closed(db, "2026-02", CAT, 10_000_00, 9_000_00);
      closed(db, "2026-03", CAT, 12_000_00, 13_000_00);
      await closeBudgetMonths(env(db), MULT);

      const hist = await budgetsRepo.monthsForCategory(db as unknown as never, CAT, 6);
      assert.deepEqual(hist.map((m) => m.ym), ["2026-02", "2026-03", "2026-04"]);
      // January and everything before it stay ABSENT. There is no record of what the limit was
      // then, and writing today's limit into them would produce a verdict on a month nobody
      // measured — a chart that looks measured but is not.
      assert.equal(hist.length, 3);
    });
  } finally {
    restore();
  }
});
