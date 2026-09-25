/**
 * §BUDGET-MEMORY — the carry a closed month hands forward, closing a month, and the track record.
 * A wrong carry still renders a plausible envelope, so every rule here is silent when broken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetStatus, budgetHistory, closeBudgetMonths } from "../lib/finance/budgets.ts";
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
      const r = await closeBudgetMonths(env(db));
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
      await closeBudgetMonths(env(db));
      const before = (await budgetsRepo.closedMonth(db as unknown as never, "2026-04")).get(CAT)!;

      // Spending appears afterwards, as it does when an old row is re-categorised months later.
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, created_at)
         VALUES ('late-april', 'acc-uah', 'manual', ?, -900000, 980, 1, 0)`,
      ).run(Math.floor(new Date("2026-04-20T10:00:00.000Z").getTime() / 1000));

      const second = await closeBudgetMonths(env(db));
      assert.equal(second.closed, 0, "already closed → no work at all");
      const after = (await budgetsRepo.closedMonth(db as unknown as never, "2026-04")).get(CAT)!;
      // A closed month is a RECORD, not a live query: the carry chain is built on this number, and
      // a figure that keeps moving would silently restate a limit the user already lived with.
      assert.equal(after.spent_minor, before.spent_minor);
    });

    await t.test("§BUDGET-ZERO: a limit of 0 is an envelope, and 'no envelope' is its absence", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE budgets SET amount = 0 WHERE category_id = ?").run(CAT);

      const rows = await budgetStatus(env(db), MULT);
      const row = rows.find((b) => b.id === CAT);
      // Before §BUDGET-ZERO the canon filtered `amount > 0`, so this row simply vanished and
      // «сюди я не витрачаю» was indistinguishable from never having set a budget.
      assert.ok(row, "a zero envelope is still an envelope");
      assert.equal(row!.base_amount, 0);
      assert.equal(row!.amount, 0);

      // …and deleting the row is what "not budgeted" means.
      await budgetsRepo.clear(db as unknown as never, CAT, "month");
      const after = await budgetStatus(env(db), MULT);
      assert.equal(after.find((b) => b.id === CAT), undefined);
    });

  } finally {
    restore();
  }
});

/**
 * The record read across ALL envelopes — «чи я взагалі тримаю план».
 *
 * The table has had this answer since migration 0043 and no reader that asked for it. The two
 * that existed each took a slice: the auto-budget reduces a category to a ratio, and the category
 * page draws one envelope. So a person could see «зараз 70%» on every screen and nowhere find out
 * whether that was better or worse than last month, which is the question a budget is kept for.
 */
test("§BUDGET-MEMORY: the whole-plan track record", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);   // 2026-05-14
  try {

    await t.test("§BASE-CUR: a closed month is stored in hryvnia and comes out in the reader's base", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('rates', ?)")
        .run(JSON.stringify({ 840: 2 }));
      closed(db, "2026-04", 1, 10_000_00, 8_000_00);

      const uah = await budgetHistory(env(db));
      const usd = await budgetHistory({ ...env(db), UI_CURRENCY: 840 } as unknown as Env);

      assert.equal(uah.months[0].limit, 10_000_00);
      // Exactly half. An archive is written in hryvnia on purpose (its unit must not depend on
      // who woke the cron), so every read has to convert — and this one did not, which put the
      // history strip and the envelope above it in different currencies on the same card.
      assert.equal(usd.months[0].limit, 5_000_00);
      assert.equal(usd.months[0].spent, 4_000_00);
      // The verdict is a comparison, so it survives the conversion unchanged.
      assert.equal(usd.months[0].kept, true);
    });
  } finally {
    restore();
  }
});

/**
 * §BUDGET-REACH — a limit the app's OWN level says cannot be met.
 *
 * The real case: «Комуналка і звʼязок» limited at 1 087 against months of 1 246 / 1 285 / 2 531 /
 * 1 458. The auto-budget set that limit AT the canonical level — and the level was understated 1.5×
 * by the bug §LEVEL-WINDOW fixed. The envelope has read «153% перевищено» ever since, about a
 * target no amount of discipline could reach. The app was disagreeing with itself and reporting
 * the user as the one at fault.
 */
test("§BUDGET-REACH: a limit under the app's own level is flagged, never corrected", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
    const mid = (mAgo: number): number => {
      const d = new Date(NOW * 1000);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - mAgo, 15, 9, 0, 0) / 1000);
    };
    // Every complete month of the level window carries a utility bill — the owner's real figures,
    // which average far above the limit the auto-budget set from the understated level.
    // ⚠️ The window is six months here, not the four his ledger covers: a category quiet in two of
    // them would divide by six and land back under the limit, which is §LEVEL-WINDOW's own point
    // and would make this test pass or fail for the wrong reason.
    const amounts = [124_600, 128_500, 130_000, 253_100, 145_800, 140_000];
    amounts.forEach((amount, i) => {
      const at = mid(amounts.length - i);
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
         VALUES (?, 'acc-uah', 'mono', ?, ?, 980, 'Utilities', 7, ?)`,
      ).run(`u-${i}`, at, -amount, at);
    });
    // The limit the auto-budget set from the understated level.
    db.raw.prepare("INSERT INTO budgets (category_id, period, amount, currency_code) VALUES (7, 'month', 108700, 980)").run();

    const rows = await budgetStatus(testEnv(db) as never, "1.0", NOW);
    const util = rows.find((r) => r.id === 7);
    assert.ok(util, "the envelope exists");
    assert.equal(util.unreachable, true, "the limit is below the level the app itself computes");
    assert.ok((util.level ?? 0) > util.base_amount, "and the level travels with it, so the screen can offer the number");
    // ⚠️ The limit is UNCHANGED. It is a decision — possibly a deliberate squeeze — and raising it
    // silently would discard the user's own work (§RULES-UI apply, §SIMILAR, the §AI-AUDIT guard).
    assert.equal(util.base_amount, 108700);
  } finally { restore(); }
});
