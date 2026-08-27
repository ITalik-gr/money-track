/**
 * §BURN-SHAPE — the canonical monthly burn, and what it is made of.
 *
 * WHY THIS FILE EXISTS. `sumLevels` is the divisor of runway, the single most important number in
 * the app for someone out of work, and until now nothing checked it against the months it claims
 * to describe. The owner read 44 784 ₴/міс and said «такого і близько немає». He was right about
 * the feeling and the arithmetic was right too, which is exactly the situation a test has to pin:
 *
 *   measured on his ledger, 2026-08-27 — Apr 42 618 · May 39 116 · Jun 35 442 · Jul 46 581,
 *   mean 40 939, burn 44 784. The gap is the `fixed` branch pricing rent at what he pays NOW
 *   (April had no rent charge at all) — which is correct and forward-looking.
 *
 * So the invariant is NOT "burn equals the mean month". It is that burn stays in the same
 * neighbourhood as the months it is built from, because the alternative — a burn that has drifted
 * off on its own — is undetectable by eye and moves runway, every budget proposal and the feed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { categoryMonthlyLevels, sumLevels, burnShape } from "../lib/finance/levels.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
const DAY = 86400;
const MONTH_KEYS = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"];

/** One spend row, in hryvnia minor units, on a given Kyiv day. */
function spend(db: MemDb, id: string, o: { amount: number; at: number; category: number }): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
     VALUES (?, 'acc-uah', 'mono', ?, ?, 980, 'M', ?, ?)`,
  ).run(id, o.at, -o.amount, o.category, o.at);
}

/** Kyiv-noon timestamp for the 15th of a `YYYY-MM` key — safely inside the month in any zone. */
const midMonth = (ym: string): number => {
  const [y, m] = ym.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, 15, 9, 0, 0) / 1000);
};

async function levelsOf(db: MemDb) {
  return await categoryMonthlyLevels(testEnv(db) as never, "1.0", { now: NOW });
}

test("§BURN-SHAPE: burn stays in the neighbourhood of the months it is built from", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    // A steady ledger: rent every month, groceries every month, both stable.
    let n = 0;
    for (const ym of MONTH_KEYS) {
      spend(db, `rent-${++n}`, { amount: 1_250_000, at: midMonth(ym), category: 8 });
      spend(db, `food-${++n}`, { amount: 600_000, at: midMonth(ym) + DAY, category: 1 });
    }
    const levels = await levelsOf(db);
    const burn = sumLevels(levels);

    // The fixture seeds its own history too, so this asserts the RELATION, not a figure: burn is
    // the sum of per-category levels, and the mean month is the sum of per-category means. They
    // are two readings of one window and must not part company.
    let meanSum = 0;
    for (const v of levels.values()) meanSum += v.mean;
    assert.ok(meanSum > 0, "the fixture must actually contain spending");
    const drift = Math.abs(burn - meanSum) / meanSum;
    assert.ok(drift <= 0.15, `burn ${burn} drifted ${(drift * 100).toFixed(1)}% from the mean of months (${meanSum})`);
  } finally { restore(); }
});

test("§BURN-SHAPE: the split ADDS UP to the burn, always", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const levels = await levelsOf(db);
    const shape = burnShape(levels);
    // The one thing a reader (and the model) is told: these are parts of the burn, not additions.
    assert.equal(shape.total, sumLevels(levels));
    assert.equal(shape.recurring + shape.lumpy, shape.total);
  } finally { restore(); }
});

test("a quarterly charge is LUMPY; a monthly one is not", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    // The owner's ФОП tax: paid in two of the six covered months, ~equal amounts. It misses the
    // 55%-of-window test at 50.5%, which is why "active in at most half the months" is the other
    // half of the rule — this is the single largest lump he has.
    spend(db, "tax-1", { amount: 858_800, at: midMonth("2025-11"), category: 24 });
    spend(db, "tax-2", { amount: 842_400, at: midMonth("2026-02"), category: 24 });
    // Rent: every month, stable. The archetype of a recurring cost.
    let n = 0;
    for (const ym of MONTH_KEYS) spend(db, `r-${++n}`, { amount: 1_250_000, at: midMonth(ym), category: 8 });

    const levels = await levelsOf(db);
    assert.equal(levels.get(24)?.lumpy, true, "a quarterly tax is a lump");
    assert.equal(levels.get(8)?.lumpy, false, "rent every month is not");
  } finally { restore(); }
});

test("one big month makes a category lumpy — the dentist, and the electronics spree", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    // «Здоровʼя»: two small months and one 5 000 ₴ visit that became «1 795/міс» forever.
    spend(db, "h-1", { amount: 123_300, at: midMonth("2025-11"), category: 4 });
    spend(db, "h-2", { amount: 94_800, at: midMonth("2025-12"), category: 4 });
    spend(db, "h-3", { amount: 500_000, at: midMonth("2026-02"), category: 4 });

    const levels = await levelsOf(db);
    assert.equal(levels.get(4)?.lumpy, true);
    // ⚠️ The LEVEL is untouched. A lump is money that left the account, and a runway computed
    // without the tax that arrives every quarter is a lie in the more dangerous direction. The
    // split only lets the app SAY which half is which.
    assert.ok((levels.get(4)?.level ?? 0) > 0, "the level still counts the money");
  } finally { restore(); }
});

test("a spread-out variable category is NOT lumpy", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    // Groceries: every month, different amounts, no single month dominating. This is the case
    // that must stay in `recurring`, or the split would call ordinary life irregular.
    const amounts = [565_100, 620_400, 601_400, 548_800, 590_000, 610_000];
    amounts.forEach((amount, i) => spend(db, `g-${i}`, { amount, at: midMonth(MONTH_KEYS[i]), category: 1 }));
    const levels = await levelsOf(db);
    assert.equal(levels.get(1)?.lumpy, false);
  } finally { restore(); }
});
