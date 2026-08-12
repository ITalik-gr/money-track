/**
 * The canon's central CLAIM, made testable: one definition of spending, so every screen agrees.
 *
 * `golden.test.ts` pins what each endpoint returns; it cannot notice that two of them have started
 * describing the same money differently, because both goldens would simply be re-recorded. That is
 * the failure mode this project keeps paying for — §CUR-PLAN, §SUB-MONTH, §REFUND and the budget
 * push were all ONE concept computed in two places, and each was found by a person noticing two
 * numbers about the same thing rather than by a test.
 *
 * So these assert RELATIONSHIPS, not values. They survive a fixture change, and they fail exactly
 * when a breakdown stops reconciling with the total it is a breakdown of.
 *
 * Verified on 2026-08-12 while auditing the statistics: all of the identities below already held.
 * That is the result worth recording — the suite exists to keep them holding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

async function get<T>(db: MemDb, path: string): Promise<T> {
  const res = await api.request(path, { method: "GET" }, testEnv(db));
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return await res.json() as T;
}

function fixture(): MemDb {
  const db = migratedDb();
  seed(db);
  return db;
}

const sum = (xs: { spent: number }[]) => xs.reduce((s, x) => s + x.spent, 0);

interface Overview {
  summary: { spend: number; income: number; n: number };
  byCategory: { category_id: number | null; spent: number }[];
  byAccount: { spent: number }[];
  byImportance: { spent: number }[];
  byMerchant: { spent: number }[];
}

test("canon: every breakdown of a period reconciles with that period's total", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    for (const preset of ["week", "month", "quarter", "year"] as const) {
      const o = await get<Overview>(db, `/analytics/overview?preset=${preset}`);
      await t.test(preset, () => {
        // Each of these is a PARTITION of the same rows — a different question about one set of
        // money. If one drifts, a screen starts quoting a total its own chart does not add up to.
        assert.equal(sum(o.byCategory), o.summary.spend, "categories must add up to the total");
        assert.equal(sum(o.byAccount), o.summary.spend, "accounts must add up to the total");
        assert.equal(sum(o.byImportance), o.summary.spend, "importance must add up to the total");
      });
    }
  } finally { restore(); }
});

test("canon: byMerchant is a TOP-10, not a partition — and that is why it may not add up", async () => {
  // Documented rather than asserted away. It is limited to ten rows and excludes operations with
  // no merchant, so its sum can land on either side of the total: a §REFUND carries a NEGATIVE
  // spend and sorts last, so leaving it out makes the visible sum LARGER than the real one.
  // Anyone comparing the two must know this; a test that asserted equality here would be wrong.
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const o = await get<Overview>(db, "/analytics/overview?preset=quarter");
    assert.ok(o.byMerchant.length <= 10, "byMerchant is capped at ten rows");
    assert.notEqual(sum(o.byMerchant), o.summary.spend,
      "the fixture deliberately contains a refund outside the top ten — if this ever becomes " +
      "equal, either the fixture lost its refund or byMerchant stopped being a top-N");
  } finally { restore(); }
});

test("canon: the envelope and the overview agree on what a category spent", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    // `budgetStatus` computes month-to-date from the canon; the overview's `month` preset is the
    // same window. These are the two places a person sees "spent on Groceries" side by side — the
    // Plan screen and the Stats donut — and they used to be computed by different code (the
    // Telegram push had a third version and quoted different numbers).
    const [budgets, o] = await Promise.all([
      get<{ id: number; spent: number }[]>(db, "/budgets/status"),
      get<Overview>(db, "/analytics/overview?preset=month"),
    ]);
    assert.ok(budgets.length, "the fixture has budgets");
    for (const b of budgets) {
      const cat = o.byCategory.find((c) => c.category_id === b.id);
      assert.equal(b.spent, cat?.spent ?? 0, `category ${b.id}: envelope vs overview`);
    }
  } finally { restore(); }
});

test("canon: the category page agrees with the envelope, to the kopeck", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const budgets = await get<{ id: number; spent: number }[]>(db, "/budgets/status");
    for (const b of budgets) {
      const page = await get<{ recurring: number; oneoff: number; budget: { spent: number } | null }>(
        db, `/categories/${b.id}/overview`);
      // The page splits the same money into repeating and one-off (§E1). The split has to be
      // exhaustive, or the tile above it would quietly under-report the month. This identity is
      // also what forced the endpoint's default window to become month-to-date: with a rolling
      // 30 days its own two halves described different periods.
      assert.equal(page.recurring + page.oneoff, b.spent, `category ${b.id}: split vs envelope`);
      assert.equal(page.budget?.spent, b.spent, `category ${b.id}: page envelope vs canon`);
    }
  } finally { restore(); }
});

test("canon: safe-to-spend is exactly its own arithmetic", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const s = await get<{ safe: number; income: number; spend: number; subs_remaining: number }>(
      db, "/analytics/safe-to-spend");
    // Stated as an identity because the figure is ACTIONABLE — people spend against it. A rounding
    // or sign slip here is money the app told someone they had.
    assert.equal(s.safe, s.income - s.spend - s.subs_remaining);
  } finally { restore(); }
});

test("canon: the weight split adds up to that month's spending", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const hist = await get<{ months: { month: string; spend: number; essential: number; discretionary: number; optional: number }[] }>(
      db, "/analytics/monthly-history?months=12");
    for (const m of hist.months) {
      // §IMPORTANCE-TREND. `EFF_IMPORTANCE` falls back to 'discretionary', so nothing can fall
      // outside the three — which is exactly what makes the stacked view honest: a bar that did
      // not reach the month's total would be silently hiding spending.
      assert.equal(m.essential + m.discretionary + m.optional, m.spend, `${m.month}: split vs spend`);
    }
  } finally { restore(); }
});

test("canon: monthly history's current month is the month preset", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const [hist, o] = await Promise.all([
      get<{ months: { month: string; spend: number; income: number }[] }>(db, "/analytics/monthly-history?months=6"),
      get<Overview>(db, "/analytics/overview?preset=month"),
    ]);
    const current = hist.months[hist.months.length - 1];
    // The long trend and the current period are drawn on different screens from different queries;
    // the last point of one IS the total of the other, and a reader who spots them disagreeing has
    // no way to tell which is lying.
    assert.equal(current?.spend, o.summary.spend, "last trend point vs month total (spend)");
    assert.equal(current?.income, o.summary.income, "last trend point vs month total (income)");
  } finally { restore(); }
});
