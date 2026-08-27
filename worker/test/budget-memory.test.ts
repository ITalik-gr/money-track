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

    await t.test("the close carries the chain forward, and respects the rollover flag", async () => {
      const db = migratedDb();
      seed(db);
      setRollover(db, CAT, true);
      closed(db, "2026-03", CAT, 15_000_00, 14_000_00);   // 1 000 ₴ into April

      await closeBudgetMonths(env(db));
      const april = (await budgetsRepo.closedMonth(db as unknown as never, "2026-04")).get(CAT)!;
      assert.equal(april.carry_in_minor, 1_000_00);

      // …and with the flag off, the same March row hands over nothing.
      const db2 = migratedDb();
      seed(db2);
      setRollover(db2, CAT, false);
      closed(db2, "2026-03", CAT, 15_000_00, 14_000_00);
      await closeBudgetMonths(env(db2));
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

    await t.test("§BUDGET-ZERO: the ratio is binary — kept, or broken", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE budgets SET amount = 0 WHERE category_id = ?").run(CAT);
      // The fixture spends in category 1 this month, so this envelope is broken.
      const broken = (await budgetStatus(env(db), MULT)).find((b) => b.id === CAT)!;
      assert.ok(broken.spent > 0);
      assert.equal(broken.ratio, 1, "no 'how far over' when the limit is nothing");
      // The projection must not invent a percentage of zero either — `draftBudgetForecast`
      // would otherwise announce a forecast for a category the user said they avoid.
      assert.equal(broken.projected_ratio, broken.ratio);
      assert.ok(Number.isFinite(broken.ratio) && Number.isFinite(broken.projected_ratio));

      // A zero envelope with nothing spent is the perfectly kept one: 0%, not "over".
      // A category with no transactions AT ALL, chosen from the data rather than hard-coded, so
      // the scenario cannot quietly start measuring something else when the fixture grows.
      const db2 = migratedDb();
      seed(db2);
      const quiet = db2.raw.prepare(
        `SELECT id FROM categories
         WHERE is_income = 0 AND parent_id IS NULL
           AND id NOT IN (SELECT COALESCE(category_id, -1) FROM transactions)
         ORDER BY id LIMIT 1`,
      ).get() as { id: number };
      db2.raw.prepare(
        "INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, 'month', 0, 980, 0)",
      ).run(quiet.id);

      const kept = (await budgetStatus(env(db2), MULT)).find((b) => b.id === quiet.id)!;
      assert.equal(kept.spent, 0);
      assert.equal(kept.ratio, 0, "the best possible outcome is not an 'over' state");
    });

    await t.test("§BUDGET-ZERO: a closed month counts ANY spend as a miss", async () => {
      const db = migratedDb();
      seed(db);
      closed(db, "2026-03", CAT, 0, 0);          // kept
      closed(db, "2026-04", CAT, 0, 1_20);       // broken by 1.20 ₴

      const rec = (await budgetsRepo.trackRecord(db as unknown as never, "2026-01")).get(CAT)!;
      assert.equal(rec.closed, 2);
      assert.equal(rec.over, 1, "a single hryvnia breaks the only promise a zero envelope makes");
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
      await closeBudgetMonths(env(db));

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
    await t.test("nothing closed yet is a YOUNG record, not a failure", async () => {
      const db = migratedDb();
      seed(db);
      const h = await budgetHistory(env(db));
      assert.equal(h.months_closed, 0);
      // `null`, not 0: «0% утримано» is a verdict, and the data supports no verdict at all.
      assert.equal(h.kept_pct, null);
      assert.deepEqual(h.months, []);
    });

    await t.test("a month is judged on the PLAN as a whole, not envelope by envelope", async () => {
      const db = migratedDb();
      seed(db);
      // One envelope 2 000 ₴ over, the other 5 000 ₴ under. The plan held; counting envelopes
      // would call the month a failure, which is a different and less useful claim.
      closed(db, "2026-04", 1, 15_000_00, 17_000_00);
      closed(db, "2026-04", 2, 10_000_00, 5_000_00);
      const h = await budgetHistory(env(db));

      assert.equal(h.months.length, 1);
      assert.equal(h.months[0].kept, true);
      assert.equal(h.months[0].spent, 22_000_00);
      assert.equal(h.months[0].limit, 25_000_00);
      // The finer reading travels alongside rather than replacing it.
      assert.equal(h.months[0].kept_envelopes, 1);
      assert.equal(h.months[0].envelopes, 2);
      // `kept_pct` counts ENVELOPE-months, which is the denominator the auto-budget also uses.
      assert.equal(h.kept_pct, 50);
    });

    await t.test("the limit compared against is the one that was IN FORCE, carry included", async () => {
      const db = migratedDb();
      seed(db);
      // Spent 16 000 against a 15 000 base — but 2 000 was carried in, so the month held.
      // Comparing against today's limit is a verdict the data cannot support.
      closed(db, "2026-04", 1, 15_000_00, 16_000_00, 2_000_00);
      const h = await budgetHistory(env(db));
      assert.equal(h.months[0].limit, 17_000_00);
      assert.equal(h.months[0].kept, true);
    });

    await t.test("the streak counts back from the LATEST close, not the best run ever", async () => {
      const db = migratedDb();
      seed(db);
      closed(db, "2026-01", 1, 10_000_00, 9_000_00);   // kept
      closed(db, "2026-02", 1, 10_000_00, 9_000_00);   // kept
      closed(db, "2026-03", 1, 10_000_00, 9_000_00);   // kept
      closed(db, "2026-04", 1, 10_000_00, 12_000_00);  // blown — the streak is over
      const cat = (await budgetHistory(env(db))).categories.find((x) => x.category_id === 1)!;

      assert.equal(cat.closed, 4);
      assert.equal(cat.over, 1);
      // A three-month run that ended last month answers a question nobody asked.
      assert.equal(cat.streak, 0);
      // The strip keeps the ORDER, because «зривався спочатку» and «зривається зараз» need
      // opposite reactions and a ratio cannot tell them apart.
      assert.deepEqual(cat.months.map((m) => m.kept), [true, true, true, false]);
    });

    await t.test("a currently-held streak is counted, and only the unbroken tail", async () => {
      const db = migratedDb();
      seed(db);
      closed(db, "2026-01", 1, 10_000_00, 12_000_00);  // blown
      closed(db, "2026-02", 1, 10_000_00, 9_000_00);
      closed(db, "2026-03", 1, 10_000_00, 9_000_00);
      const cat = (await budgetHistory(env(db))).categories.find((x) => x.category_id === 1)!;
      assert.equal(cat.streak, 2);
    });

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

test("§BUDGET-REACH: a deliberate ZERO envelope is never called unreachable", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
    // §BUDGET-ZERO: «сюди я свідомо не витрачаю» is a plan, not a miscalculation. Without the
    // guard every level above zero would flag it, i.e. every zero envelope, always.
    db.raw.prepare("INSERT INTO budgets (category_id, period, amount, currency_code) VALUES (6, 'month', 0, 980)").run();
    const rows = await budgetStatus(testEnv(db) as never, "1.0", NOW);
    assert.equal(rows.find((r) => r.id === 6)?.unreachable, false);
  } finally { restore(); }
});
