/**
 * `/insights/*` — the four derived readings, checked against the numbers they claim to be about.
 *
 * The point of every assertion here is RECONCILIATION, not the presence of a field. Each of these
 * blocks sits on the same screen as the total it is decomposing, so the failure that matters is
 * not "the endpoint broke" — it is "the endpoint answers plausibly and disagrees with the figure
 * printed above it". That is the shape of §CUR-PLAN, §SUB-MONTH and §HEALTH, and it is invisible
 * in review because both numbers look fine on their own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { SpendProfile, Momentum, IncomeAllocation, SpendFloor } from "../../shared/api/insights.ts";

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

const YEAR = "?from=0&to=99999999999";

test("§SPEND-PROFILE: quiet days can never exceed the days in the window", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const p = await get<SpendProfile>(fixture(), "/insights/spend-profile");
    assert.ok(p.quiet_days.quiet <= p.quiet_days.days, "more quiet days than days is an APP_TZ bug");
    assert.ok(p.quiet_days.longest_streak <= p.quiet_days.quiet, "a streak cannot be longer than the total");
    // Today is not counted until it is over: a window ending this afternoon has no verdict on it,
    // and counting it as quiet would report a fresh quiet day every morning.
    assert.ok(p.quiet_days.days >= 0);
  } finally { restore(); }
});

test("§SPEND-PROFILE: concentration is a partition of the same spending", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const p = await get<SpendProfile>(fixture(), `/insights/spend-profile${YEAR}`);
    assert.ok(p.concentration.merchants > 0, "the fixture has merchants; zero means the join broke");
    // Reaching half takes at most every merchant and at least one — the bounds are what catch a
    // loop that walked the list the wrong way round.
    assert.ok(p.concentration.merchants_for_half >= 1);
    assert.ok(p.concentration.merchants_for_half <= p.concentration.merchants);
    assert.ok(p.concentration.top5_share > 0 && p.concentration.top5_share <= 1);
  } finally { restore(); }
});

test("§SPEND-PROFILE: over ALL time every merchant is a new face, and they add up to the total", async () => {
  // The strongest available statement about `first_seen`: with the window opened to everything,
  // no charge can predate it, so the "new" spend must be the whole spend. If `first_seen` were
  // computed within the window instead of over the ledger, this is where it shows.
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const p = await get<SpendProfile>(fixture(), `/insights/spend-profile${YEAR}`);
    assert.equal(p.new_faces.merchants, p.concentration.merchants);
    assert.equal(p.new_faces.share, 1);
    assert.equal(p.new_faces.spent, p.total, "new-face spend must reconcile with the period total");
  } finally { restore(); }
});

test("§INCOME-SPLIT: the three bands plus what is left reconstruct the income exactly", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const a = await get<IncomeAllocation>(fixture(), `/insights/income-split${YEAR}`);
    assert.equal(
      a.essential + a.discretionary + a.optional + a.left, a.income,
      "the bands and the remainder ARE the income — a gap means one side used a different population",
    );
  } finally { restore(); }
});

test("§INCOME-SPLIT: shares are shares OF INCOME, and negative headroom is reported as such", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const a = await get<IncomeAllocation>(fixture(), `/insights/income-split${YEAR}`);
    assert.ok(a.shares, "the fixture has income, so there is an answer");
    const s = a.shares!;
    // They sum to 1 by construction, including when `left` is negative — which is the case the
    // block exists for and the one a clamp at zero would have hidden.
    assert.ok(Math.abs(s.essential + s.discretionary + s.optional + s.left - 1) < 0.005);
    /**
     * DIRECTION, not just the identity above.
     *
     * The identity `e + d + o + left === income` holds under an inverted sign too — `left` simply
     * absorbs it — and it did: the first version of this endpoint reported essentials at −7% of
     * income and `left` at 146%, i.e. that spending money had increased what remained. It passed
     * the reconciliation test. Only a claim about which way the numbers point catches that.
     */
    assert.ok(a.essential >= 0 && a.discretionary >= 0 && a.optional >= 0,
      "a band is money that LEFT; a negative one means the sign was flipped twice");
    assert.ok(a.left < a.income, "money was spent, so what is left cannot be all of the income");
  } finally { restore(); }
});

test("§FLOOR: floor + lumpy IS the burn, and the floor runway is never the shorter one", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const f = await get<SpendFloor>(fixture(), "/insights/floor");
    assert.equal(f.floor + f.lumpy, f.burn, "the split must be OF the burn, not additions to it");
    if (f.runway_months != null && f.floor_months != null) {
      // Dividing the same cushion by a smaller denominator cannot give fewer months. If it ever
      // does, the two runways were computed against different cushions — which is exactly the
      // second-definition failure this block was built to avoid.
      assert.ok(f.floor_months >= f.runway_months);
    }
    for (const p of f.parts) assert.ok(p.level > 0, "a named part of the floor with no money is noise");
  } finally { restore(); }
});

/**
 * A ledger built to CONTAIN a run, because the seeded fixture contains none — the momentum
 * assertions below it would otherwise all hold over an empty list and prove nothing. That is the
 * §SUB-MONTH lesson: a documented safeguard nobody exercises reads as coverage and is not.
 *
 * «Кафе» (2) climbs for four straight months; «Продукти» (1) stays flat. One must be reported and
 * the other must not, and a threshold that fires on both is the failure mode this block was
 * written to avoid.
 */
function momentumDb(): MemDb {
  const db = migratedDb();
  db.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('acc1', 'black', 'Картка', 980, 100000, 0, 1, 0)`,
  ).run();
  const at = (monthsAgo: number) => {
    const d = new Date(FROZEN_NOW_ISO);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 15, 12) / 1000);
  };
  const add = (id: string, cat: number, minor: number, monthsAgo: number) =>
    db.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, hold, is_transfer)
       VALUES (?, 'acc1', 'mono', ?, ?, 980, ?, ?, 0, 0)`,
    ).run(id, at(monthsAgo), -minor, `M${cat}`, cat);

  // Rising: 1 000 → 2 000 → 3 500 → 5 500 → 7 500 (four moves, each well over 8% and 200 ₴).
  [[5, 100000], [4, 200000], [3, 350000], [2, 550000], [1, 750000]].forEach(([m, v], i) => add(`up${i}`, 2, v, m));
  // Flat: the same figure every month. Never a move, so never a run.
  [5, 4, 3, 2, 1].forEach((m, i) => add(`flat${i}`, 1, 300000, m));
  return db;
}

test("§MOMENTUM: a sustained climb is reported and a flat category is not", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = await get<Momentum>(momentumDb(), "/insights/momentum");
    const cafe = m.rows.find((r) => r.category_id === 2);
    assert.ok(cafe, "four consecutive rises must be reported — otherwise the block never fires");
    assert.equal(cafe!.direction, "up");
    assert.ok(cafe!.run >= 3);
    assert.ok(cafe!.change > 0);
    // The flat category is the control: a threshold loose enough to call it a trend would call
    // half of every real ledger a trend, and a block that flags everything is read by nobody.
    assert.ok(!m.rows.some((r) => r.category_id === 1), "an unchanged category is not momentum");
  } finally { restore(); }
});

test("§MOMENTUM: a run that ENDED is not momentum", async () => {
  // Three rises followed by a fall. The question the block answers is "is this happening now", so
  // walking backwards must stop at the reversal rather than find the older run behind it.
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = momentumDb();
    db.raw.prepare("UPDATE transactions SET amount = -50000 WHERE id = 'up4'").run();   // last month collapses
    const m = await get<Momentum>(db, "/insights/momentum");
    const cafe = m.rows.find((r) => r.category_id === 2);
    // Either absent, or reported as the ONE fall it now is — never still climbing.
    if (cafe) assert.equal(cafe.direction, "down");
  } finally { restore(); }
});

test("§MOMENTUM: a run is only ever claimed over COMPLETE months, and never the current one", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = await get<Momentum>(fixture(), "/insights/momentum");
    const now = new Date(FROZEN_NOW_ISO);
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    assert.ok(!m.months.includes(thisMonth), "a partial month drags every category downward");
    for (const r of m.rows) {
      assert.ok(r.run >= 3, "two moves is a pair of ordinary months, not a direction");
      assert.equal(r.series.length, m.months.length, "one figure per month, or the chart lies");
      const start = r.series[r.series.length - 1 - r.run]!;
      const end = r.series[r.series.length - 1]!;
      assert.equal(r.change, end - start);
      // The direction has to match the arithmetic it is drawn from.
      assert.equal(r.direction, r.change > 0 ? "up" : "down");
    }
  } finally { restore(); }
});

test("§MOMENTUM: the same window on the same data twice gives the same answer", async () => {
  // Cheap, and it pins the one thing a `Map` iteration order could quietly change: the sort is by
  // absolute money, so two runs must not disagree about which category leads the block.
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const a = await get<Momentum>(db, "/insights/momentum");
    const b = await get<Momentum>(db, "/insights/momentum");
    assert.deepEqual(a.rows.map((r) => r.category_id), b.rows.map((r) => r.category_id));
  } finally { restore(); }
});
