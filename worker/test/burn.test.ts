/**
 * §BURN-SHAPE — the canonical monthly burn (the runway divisor) stays near the months it is built from,
 * and its recurring/lumpy split always adds up to it.
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
