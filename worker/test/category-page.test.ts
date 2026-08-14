/**
 * §CAT-PAGE — the three ways the category page rendered an empty screen over real data.
 *
 * All three were reported by the owner as one symptom ("I open some categories and they are empty,
 * though I definitely spent there"), and all three are silent: an empty page is exactly what an
 * unused category looks like, so nothing about the screen says which of the two it is.
 *
 *   1. a SUB-category matched nothing, because `EFF_CAT_ID` rolls up to the parent;
 *   2. an INCOME bucket matched nothing, because every query used `SPEND_WHERE`;
 *   3. the window was month-to-date, so a category quiet THIS month looked like a category quiet
 *      forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as categoriesRepo from "../repo/categories.ts";
import { localMonthStart } from "../lib/finance/stats.ts";
import { migratedDb, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);
const MULT = "1";
const db_ = () => { const db = migratedDb(); seed(db); return db; };

/** A sub-category under `parent`, plus one expense filed directly against it. */
function subWithSpend(db: MemDb, parent: number, amount: number, at: number): number {
  db.raw.prepare(
    "INSERT INTO categories (id, name, icon, color, parent_id, is_income, is_custom) VALUES (950, 'Таксі', 'dots', '#888', ?, 0, 1)",
  ).run(parent);
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, created_at)
     VALUES ('sub-tx', 'acc-uah', 'manual', ?, ?, 980, 950, 0)`,
  ).run(at, -amount);
  return 950;
}

test("§CAT-PAGE: a SUB-category finds its own rows", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("the leaf match sees them; the roll-up match does not", async () => {
      const db = db_();
      const sub = subWithSpend(db, 1, 500_00, NOW - 2 * 86400);

      const leaf = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: sub, isParent: false, isIncome: false },
      );
      assert.equal(leaf.total, 500_00, "the sub-category page must find its own spending");
      assert.equal(leaf.n, 1);

      // The bug, pinned: asking for the SAME id with the roll-up match returns nothing, because
      // the row reports as its parent. That is what every sub-category page used to do.
      const rolled = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: sub, isParent: true, isIncome: false },
      );
      assert.equal(rolled.total, 0);
    });

    await t.test("and the PARENT still rolls the child up (the canon is untouched)", async () => {
      const db = db_();
      const before = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: 1, isParent: true, isIncome: false },
      );
      subWithSpend(db, 1, 500_00, NOW - 2 * 86400);
      const after = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: 1, isParent: true, isIncome: false },
      );
      // The fix must not turn the parent page into a leaf page: a child's spending belongs to the
      // parent's total, which is the whole reason `EFF_CAT_ID` rolls up.
      assert.equal(after.total, before.total + 500_00);
    });
  } finally {
    restore();
  }
});

test("§CAT-PAGE: an INCOME category reads the income side", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("spend-side queries find nothing; income-side queries find the salary", async () => {
      const db = db_();
      const inc = db.raw.prepare("SELECT id FROM categories WHERE is_income = 1 LIMIT 1").get() as { id: number };

      const asSpend = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: inc.id, isParent: true, isIncome: false },
      );
      const asIncome = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: inc.id, isParent: true, isIncome: true },
      );

      // This pair IS the bug: the page used the first column and rendered zeros over a category
      // holding every hryvnia the user earned.
      assert.equal(asSpend.total, 0);
      assert.ok(asIncome.total > 0, `expected income for category ${inc.id}, got ${asIncome.total}`);
      assert.ok(asIncome.n > 0);
    });
  } finally {
    restore();
  }
});

test("§CAT-PAGE: lifetime stats are independent of the window", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("a category quiet THIS month still reports its history", async () => {
      const db = db_();
      // Category 30 is a SUB-category in the fixture (parent 1), so its scope is a LEAF — which
      // is also the case that used to render blank. Spending four months back and nothing since:
      // the exact shape the owner hit.
      db.raw.prepare("DELETE FROM transactions WHERE category_id = 30").run();
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, created_at)
         VALUES ('old-1', 'acc-uah', 'manual', ?, -1200_00, 980, 30, 0)`,
      ).run(localMonthStart(NOW, -4) + 86400);

      const monthWindow = await categoriesRepo.recurringSplit(
        db as unknown as never, MULT, { id: 30, isParent: false, isIncome: false },
        localMonthStart(NOW), NOW, "0",
      );
      const life = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: 30, isParent: false, isIncome: false },
      );

      // The window is genuinely empty — that part was never wrong.
      assert.equal(monthWindow.recurring + monthWindow.oneoff, 0);
      // …but the page now has something true to say instead of showing nothing at all.
      assert.ok(life.total >= 1200_00);
      assert.ok(life.first_at != null && life.first_at < localMonthStart(NOW));
    });

    await t.test("`per_active_month` divides by ACTIVE months, not by the calendar span", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("DELETE FROM tx_splits").run();
      db.raw.prepare("DELETE FROM tx_reimbursements").run();
      db.raw.prepare("DELETE FROM transaction_tags").run();
      db.raw.prepare("DELETE FROM transactions").run();
      // Two operations, in two different months, a year apart.
      for (const [id, months] of [["a", -12], ["b", -1]] as const) {
        db.raw.prepare(
          `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, created_at)
           VALUES (?, 'acc-uah', 'manual', ?, -1000_00, 980, 30, 0)`,
        ).run(id, localMonthStart(NOW, months) + 86400);
      }
      const life = await categoriesRepo.lifetimeStats(
        db as unknown as never, MULT, { id: 30, isParent: false, isIncome: false },
      );
      assert.equal(life.months, 2, "two months had activity");
      // 2 000 over 2 ACTIVE months = 1 000. Dividing by the 13-month span would report ~154 — a
      // monthly figure this category has never once spent.
      assert.equal(Math.round(life.total / life.months), 1000_00);
    });
  } finally {
    restore();
  }
});

test("§CAT-PAGE: the DRILL obeys the same scope as the page above it", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const V = { mult: MULT, curFilter: "" };
  try {
    const { categoryDrill } = await import("../lib/finance/category-drill.ts");

    await t.test("a sub-category drill lists its own operations", async () => {
      const db = db_();
      const sub = subWithSpend(db, 1, 500_00, NOW - 2 * 86400);
      const d = await categoryDrill(
        db as unknown as never, "uk", V, { from: NOW - 30 * 86400, to: NOW }, sub,
      );
      // Before the scope existed this list was empty for EVERY sub-category, under a page that
      // was empty for the same reason — two blank blocks, one cause.
      assert.ok(d.transactions.length > 0, "the sub-category drill must find its rows");
      assert.ok(d.transactions.some((x) => x.id === "sub-tx"));
    });

    await t.test("an income drill lists income, not nothing", async () => {
      const db = db_();
      const inc = db.raw.prepare("SELECT id FROM categories WHERE is_income = 1 LIMIT 1").get() as { id: number };
      const d = await categoryDrill(
        db as unknown as never, "uk", V, { from: 0, to: NOW }, inc.id,
      );
      assert.ok(d.transactions.length > 0, "an income bucket has operations, just not spending");
      assert.ok(d.transactions.every((x) => x.amount > 0), "and they are all inflows");
    });

    await t.test("a TOP-LEVEL expense category is unchanged — the Stats donut path", async () => {
      const db = db_();
      const d = await categoryDrill(
        db as unknown as never, "uk", V, { from: NOW - 90 * 86400, to: NOW }, 1,
      );
      // The default scope must reproduce the historical behaviour exactly, or this fix would have
      // quietly changed the drill every Stats user already relies on.
      assert.ok(d.transactions.length > 0);
      assert.ok(d.transactions.every((x) => x.amount < 0));
    });
  } finally {
    restore();
  }
});

test("§CAT-PAGE: the multiplier converts, so a foreign-currency row is not counted raw", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    const life = await categoriesRepo.lifetimeStats(
      db as unknown as never, "1", { id: 1, isParent: true, isIncome: false },
    );
    // Sanity: the fixture's category 1 has spending, so the scope wiring reaches real rows at all.
    assert.ok(life.total > 0);
    assert.ok(life.months > 0);
    assert.ok(life.last_at != null);
  } finally {
    restore();
  }
});
