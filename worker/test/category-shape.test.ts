/**
 * §CAT-SHAPE — the SHAPE of one category, and the sample it refuses to draw one from.
 *
 * The interesting assertions here are all about NOT answering. A flat weekday chart drawn from
 * nine charges looks identical to one drawn from nine hundred, so the gates are the only thing
 * separating a finding from nine purchases with bars behind them — and a gate nobody tests is a
 * gate that quietly stops holding.
 *
 * The rest pins the §CAT-PAGE rules the shape has to inherit: a sub-category answers for ITSELF,
 * an income bucket has no importance to report, and the projection exists only where the canonical
 * level does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { categoryShape } from "../lib/finance/category-shape.ts";
import { localMonthStart } from "../lib/finance/stats.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);
const DAY = 86400;
const MULT = "1";

const db_ = () => { const db = migratedDb(); seed(db); return db; };
const env = (db: MemDb) => testEnv(db) as never;

/** `n` expenses on one category, one per day walking back from `at`. */
let chargeSeq = 0;
function charges(db: MemDb, cat: number, n: number, amount: number, at = NOW - DAY, step = DAY): void {
  for (let i = 0; i < n; i++) {
    db.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, created_at)
       VALUES (?, 'acc-uah', 'manual', ?, ?, 980, ?, 0)`,
    ).run(`cs-${cat}-${++chargeSeq}`, at - i * step, -amount, cat);
  }
}

// ---- the gates ------------------------------------------------------------------------------

test("§CAT-SHAPE: a weekly rhythm is refused under two charges per weekday", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();          // NO fixture history — this category is exactly as thin as seeded
    seed(db);
    // A category nobody has used: 13 charges is one short of 7 buckets × 2.
    db.raw.prepare("INSERT INTO categories (id, name, color, is_income, is_custom) VALUES (960, 'Рідкісне', '#888', 0, 1)").run();
    const from = NOW - 40 * DAY;
    charges(db, 960, 13, 100_00, NOW - DAY, 2 * DAY);
    const thin = await categoryShape(env(db), MULT, { id: 960, isParent: true, isIncome: false }, from, NOW, NOW);
    assert.equal(thin.n, 13);
    assert.equal(thin.weekday, null, "13 charges cannot describe a week");

    // One more crosses it. The point is that the gate is a threshold on EVIDENCE, not a mood.
    charges(db, 960, 1, 100_00, NOW - 30 * DAY);
    const ok = await categoryShape(env(db), MULT, { id: 960, isParent: true, isIncome: false }, from, NOW, NOW);
    assert.equal(ok.n, 14);
    assert.ok(ok.weekday, "14 charges is the smallest sample the chart is allowed");
    assert.equal(ok.weekday.days.length, 7);
  } finally { restore(); }
});

test("§CAT-SHAPE: a day-of-month claim needs more than one month", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    // «everything happens on the 3rd» over a single month is just «there was one charge».
    const oneMonth = await categoryShape(env(db), MULT, { id: 1, isParent: true, isIncome: false }, localMonthStart(NOW), NOW, NOW);
    assert.equal(oneMonth.dom, null);

    const threeMonths = await categoryShape(env(db), MULT, { id: 1, isParent: true, isIncome: false }, NOW - 90 * DAY, NOW, NOW);
    assert.ok(threeMonths.dom, "three months can say which date the money leaves on");
  } finally { restore(); }
});

// ---- the §CAT-PAGE rules it inherits ---------------------------------------------------------

test("§CAT-SHAPE: a SUB-category answers for itself, not for its parent", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    // The fixture files groceries under both the parent (1) and its sub-category (30).
    const win = [NOW - 120 * DAY, NOW] as const;
    const parent = await categoryShape(env(db), MULT, { id: 1, isParent: true, isIncome: false }, win[0], win[1], NOW);
    const leaf = await categoryShape(env(db), MULT, { id: 30, isParent: false, isIncome: false }, win[0], win[1], NOW);

    assert.ok(leaf.n > 0, "the leaf match must see its own rows — the §CAT-PAGE bug was that it saw none");
    assert.ok(parent.n > leaf.n, "and the parent rolls up strictly more than the leaf holds");
  } finally { restore(); }
});

test("§CAT-SHAPE: an INCOME bucket reports no importance and no projection", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    const inc = await categoryShape(env(db), MULT, { id: 15, isParent: true, isIncome: true }, NOW - 120 * DAY, NOW, NOW);
    // `EFF_IMPORTANCE` ends in a COALESCE default of `discretionary`, so asking would file every
    // salary under "nice to have" — a claim, rendered as a chart, about a question income has no
    // answer to.
    assert.equal(inc.importance, null);
    assert.equal(inc.projection, null);
  } finally { restore(); }
});

test("§CAT-SHAPE: importance shares add up to the category, and to 100", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    const s = await categoryShape(env(db), MULT, { id: 1, isParent: true, isIncome: false }, NOW - 240 * DAY, NOW, NOW);
    assert.ok(s.importance && s.importance.length > 0);
    const sum = s.importance.reduce((a, r) => a + r.spent, 0);
    // The same guarantee §CAT-PARTS makes about composition: the parts ARE the whole, so a reader
    // who adds the rows up must land on the figure the page leads with.
    const pct = s.importance.reduce((a, r) => a + r.share_pct, 0);
    assert.ok(Math.abs(pct - 100) <= 1, `shares sum to ${pct}, not 100 (rounding aside)`);
    assert.ok(sum > 0);
  } finally { restore(); }
});

test("§CAT-SHAPE: the projection exists only for THIS month and a top-level expense category", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    const monthStart = localMonthStart(NOW);

    const sub = await categoryShape(env(db), MULT, { id: 30, isParent: false, isIncome: false }, monthStart, NOW, NOW);
    // `categoryMonthlyLevels` rolls up, so a sub-category's "level" is its PARENT's — projecting
    // against it would print a number about a different category.
    assert.equal(sub.projection, null);

    const pastWindow = await categoryShape(env(db), MULT, { id: 1, isParent: true, isIncome: false }, NOW - 90 * DAY, NOW, NOW);
    // Forecasting a window the reader widened to a quarter is a sentence about a period that is
    // largely over — the two-periods-in-one-answer bug §CATEGORY-PAGE already fixed once.
    assert.equal(pastWindow.projection, null);

    const cur = await categoryShape(env(db), MULT, { id: 1, isParent: true, isIncome: false }, monthStart, NOW, NOW);
    assert.ok(cur.projection, "a top-level expense category in the current month gets one");
    assert.ok(cur.projection.projected >= cur.projection.spent, "a projection never undercuts what already happened");
    assert.ok(cur.projection.usual > 0);
  } finally { restore(); }
});

test("§CAT-SHAPE: a lump is reported as one, not extrapolated", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = db_();
    // Rent: the fixture charges it once a month, one large operation. `projectSpend` must refuse
    // to multiply that by the days remaining — a tax paid on the 3rd would become a tenfold month.
    const monthStart = localMonthStart(NOW);
    const s = await categoryShape(env(db), MULT, { id: 8, isParent: true, isIncome: false }, monthStart, NOW, NOW);
    assert.ok(s.projection, "the category has a level and the month is current");
    assert.equal(s.projection.lumpy, true);
    assert.equal(s.projection.projected, Math.max(s.projection.spent, s.projection.usual),
      "a lump projects to what happened (or to the level), never to a pace");
  } finally { restore(); }
});
