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

test("§MONTH-STACK: the category stack adds up to that month's spending", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const hist = await get<{
      categories: { id: number | null; name: string; other?: boolean }[];
      months: { month: string; spend: number; by_category: Record<string, number> }[];
    }>(db, "/analytics/monthly-history?months=12");

    // The same property the weight split has, and for the same reason: a stacked bar is only
    // readable if its height IS the month. A segment silently dropped — an uncategorised row, a
    // category past the top-N cut — would draw a shorter bar that looks entirely plausible.
    for (const m of hist.months) {
      const stacked = Object.values(m.by_category).reduce((a, b) => a + b, 0);
      assert.equal(stacked, m.spend, `${m.month}: stack vs spend`);
    }

    // Every key a month uses must be a declared segment, or the chart would be handed data it has
    // no colour, no name and no legend entry for — and Recharts simply would not draw it.
    const declared = new Set(hist.categories.map((c) => (c.other ? "other" : String(c.id ?? "none"))));
    for (const m of hist.months) {
      for (const k of Object.keys(m.by_category)) {
        assert.ok(declared.has(k), `${m.month}: segment "${k}" is not declared in categories`);
      }
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


/**
 * §0.2 second pass (2026-08-27) — the on-screen blocks the MCP surface cannot see.
 *
 * The first pass compared the Advisor's snapshot against the chat tools on real data. What it
 * could not reach is everything that only exists as a rendered screen: the overview axis, the
 * forecast, the health index, the cashflow calendar. Those are checked here the only way that
 * generalises — not against a recorded number, but against the OTHER block that describes the same
 * money. A reader who sees two screens disagree has no way to tell which one is lying, and that
 * failure mode is the one this project keeps paying for.
 */

test("§0.2: the forecast's month-to-date IS the month preset", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const [f, o] = await Promise.all([
      get<{ spend: number; income: number; projectedSpend: number }>(db, "/analytics/forecast"),
      get<Overview>(db, "/analytics/overview?preset=month"),
    ]);
    // The Dashboard shows the forecast and Statistics shows the period total, side by side in the
    // same session. They are two queries over what must be one window.
    assert.equal(f.spend, o.summary.spend, "forecast spend vs month total");
    assert.equal(f.income, o.summary.income, "forecast income vs month total");
    // A projection may not be BELOW what has already been spent: the money is gone, and a forecast
    // that undercuts the fact is the one number on the screen that cannot possibly be right.
    assert.ok(f.projectedSpend >= f.spend, `projected ${f.projectedSpend} < spent ${f.spend}`);
  } finally { restore(); }
});

test("§0.2: the health index's runway is the advisor's runway", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const health = await get<{ score: number; components: { key: string; score: number }[] }>(db, "/analytics/health");
    // Both are cushion ÷ burn. They are drawn on the same page (`advisor-state`), so a divergence
    // is visible without scrolling — and the health index is the one nobody would re-derive by
    // hand, which is what makes a silent difference there durable.
    const runwayC = health.components.find((c) => c.key === "runway");
    assert.ok(runwayC, "the runway component exists");
    // The score is a clamped ratio, so the check is directional rather than numeric: a positive
    // cushion and a positive burn must not produce a zero runway component.
    const funds = await get<{ cushion: number }>(db, "/accounts/funds");
    if (funds.cushion > 0) assert.ok(runwayC.score > 0, "cushion exists but runway scored zero");
    assert.ok(health.score >= 0 && health.score <= 100, `score out of range: ${health.score}`);
  } finally { restore(); }
});

test("§HEALTH-INCOME: a month with NO income must not make income look MORE stable", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // The defect, exactly: `GROUP BY month` returns no row for a month with nothing coming in, and
    // the old code filtered `> 0` on top. So both the average and the stability score were taken
    // over the months that HAPPENED to have income — and the stability component, 15% of the
    // score, rewarded a jobless month by pretending it did not exist.
    //
    // ⚠️ The fixture cannot show this: it pays a salary every month, which is why the golden files
    // did not move when this was fixed and why nothing caught it for months.
    const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
    const mid = (mAgo: number): number => {
      const d = new Date(NOW * 1000);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - mAgo, 15, 9, 0, 0) / 1000);
    };
    function withIncomeIn(months: number[]): MemDb {
      const db = migratedDb();
      seed(db);
      // Children first — `transaction_tags`, `tx_splits` and `tx_reimbursements` reference the
      // rows we are clearing, and the harness runs with foreign keys ON (as the DO does).
      for (const tbl of ["transaction_tags", "tx_splits", "tx_reimbursements", "ai_changes"]) {
        try { db.raw.prepare(`DELETE FROM ${tbl}`).run(); } catch { /* not every table exists yet */ }
      }
      db.raw.prepare("DELETE FROM transactions").run();
      // Identical spending every month, so ONLY the income pattern differs between the two runs.
      for (let m = 1; m <= 6; m++) {
        db.raw.prepare(
          `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
           VALUES (?, 'acc-uah', 'mono', ?, -500000, 980, 'Shop', 1, ?)`,
        ).run(`s-${m}`, mid(m), mid(m));
      }
      for (const m of months) {
        db.raw.prepare(
          `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
           VALUES (?, 'acc-uah', 'mono', ?, 3000000, 980, 'Salary', 15, ?)`,
        ).run(`i-${m}`, mid(m), mid(m));
      }
      return db;
    }
    const stabilityOf = async (db: MemDb): Promise<number> => {
      const h = await get<{ components: { key: string; score: number }[] }>(db, "/analytics/health");
      return h.components.find((c) => c.key === "stability")?.score ?? -1;
    };

    const every = await stabilityOf(withIncomeIn([1, 2, 3, 4, 5, 6]));
    const half = await stabilityOf(withIncomeIn([1, 2, 3]));
    assert.ok(every >= 0 && half >= 0, "the stability component exists in both runs");
    // Earning in three months of six is LESS stable than earning in all six. Under the old code
    // both scored a perfect 100, because the empty months were never in the series at all.
    assert.ok(half < every, `income in 3 of 6 months scored ${half}, income every month scored ${every}`);
  } finally { restore(); }
});

test("§HEALTH: no component may display a percentage outside 0–100%", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // The freelance shape, which is the owner's: nothing for months, then one payment. `cv` is
    // unbounded, so `1 − cv` went to −1.24 and the card printed «-124%» as a STABILITY percentage.
    // It became reachable the moment §HEALTH-INCOME started counting the empty months — i.e. the
    // fix that made the figure honest is what exposed the display, and it would have shipped a
    // number that reads as a rendering bug to exactly the people whose income is least stable.
    const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
    const mid = (mAgo: number): number => {
      const d = new Date(NOW * 1000);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - mAgo, 15, 9, 0, 0) / 1000);
    };
    const db = migratedDb();
    seed(db);
    for (const tbl of ["transaction_tags", "tx_splits", "tx_reimbursements", "ai_changes"]) {
      try { db.raw.prepare(`DELETE FROM ${tbl}`).run(); } catch { /* not every table exists yet */ }
    }
    db.raw.prepare("DELETE FROM transactions").run();
    for (let m = 1; m <= 6; m++) {
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
         VALUES (?, 'acc-uah', 'mono', ?, -400000, 980, 'Shop', 1, ?)`,
      ).run(`sp-${m}`, mid(m), mid(m));
    }
    // One payment, six months of nothing around it.
    db.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
       VALUES ('one', 'acc-uah', 'mono', ?, 6000000, 980, 'Client', 15, ?)`,
    ).run(mid(1), mid(1));

    const h = await get<{ score: number; components: { key: string; value: string; score: number }[] }>(
      db, "/analytics/health");
    // ⚠️ The invariant is about a NORMALISED share, not about every percentage on the card. The
    // savings component shows a measured RATE, and a negative one is real information («you spent
    // more than you earned»); stability is a 0–100 share by definition, so a negative reading
    // there is not a fact about the person, it is arithmetic leaking onto the screen.
    const stab = h.components.find((c) => c.key === "stability");
    assert.ok(stab, "the stability component exists");
    const v = Number(/^(-?\d+)%$/.exec(stab.value)?.[1]);
    assert.ok(Number.isFinite(v), `stability showed a non-percentage: ${stab.value}`);
    assert.ok(v >= 0 && v <= 100, `stability displayed ${stab.value}`);
    // And it must BE the score it is shown beside — one clamped number, not two readings of it.
    assert.equal(v, stab.score, `stability shows ${stab.value} beside a score of ${stab.score}`);
    assert.ok(h.score >= 0 && h.score <= 100);
  } finally { restore(); }
});

test("§HEALTH: the savings component compares actuals, not a LEVEL against an average", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // It divided `(avgIncome − burn)` by `avgIncome` — a canonical level on one side of the ratio
    // and a raw mean on the other. On the owner's ledger that printed −15% where actual-vs-actual
    // is −5%: a "savings rate" no other screen computes, under the name the Trends strip uses for
    // the canonical one (§AI-AVGNAME states the general rule).
    const db = fixture();
    const [h, hist] = await Promise.all([
      get<{ components: { key: string; value: string }[] }>(db, "/analytics/health"),
      get<{ months: { month: string; income: number; spend: number; savings_rate_pct: number | null }[] }>(
        db, "/analytics/monthly-history?months=12"),
    ]);
    const shown = Number(/^(-?\d+)%$/.exec(h.components.find((c) => c.key === "savings")?.value ?? "")?.[1]);
    assert.ok(Number.isFinite(shown), "the savings component shows a percentage");

    // Rebuild it from the SAME public figures the Trends strip is drawn from: complete months only
    // (the current one is partial), income and spend averaged, then the canonical ratio.
    const complete = hist.months.slice(0, -1).filter((m) => m.income > 0 || m.spend > 0);
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const expected = Math.round((avg(complete.map((m) => m.income)) - avg(complete.map((m) => m.spend)))
      / avg(complete.map((m) => m.income)) * 100);
    // Within a point: the health window is the months the LEDGER covers, which for a fixture with
    // a full year of history is the same set. The check is that the BASIS matches, not the rounding.
    assert.ok(Math.abs(shown - expected) <= 1,
      `health says ${shown}% saved, the same months give ${expected}%`);
  } finally { restore(); }
});

test("§0.2: the cashflow calendar and «скоро спишеться» expand the SAME plans", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
    const [cal, up] = await Promise.all([
      get<{ items: { at: number; amount: number; kind: string }[] }>(db, "/analytics/cashflow-calendar"),
      get<{ items: { at: number; amount_uah: number }[] }>(db, "/planned/upcoming?days=30"),
    ]);
    // Both stand on `chargesBetween` (§SUB-MONTH). The calendar decides which day goes red and the
    // widget decides what to warn about; if they expanded plans differently, the app would warn
    // about a charge its own calendar does not show.
    const horizon = NOW + 30 * 86400;
    const calOut = cal.items
      .filter((m) => m.kind !== "income" && m.at > NOW && m.at <= horizon)
      .reduce((s, m) => s + m.amount, 0);
    const widget = up.items.reduce((s, i) => s + i.amount_uah, 0);
    // Within one charge's rounding: both convert per plan (§CUR-PLAN), so the sums round the same
    // way — but an exact equality would pin the horizon arithmetic rather than the agreement.
    const drift = Math.abs(calOut - widget);
    assert.ok(drift <= Math.max(100, widget * 0.02),
      `calendar outflow ${calOut} vs upcoming widget ${widget}`);
  } finally { restore(); }
});

test("§0.2: an explicit from/to window answers the same as the preset that covers it", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // §MONTH-VIEW rests on this: the month stepper drops `preset` and sends explicit bounds. If
    // the two paths disagreed, browsing to a past month would quietly re-scale every figure.
    const db = fixture();
    const preset = await get<Overview & { range: { from: number; to: number } }>(db, "/analytics/overview?preset=month");
    const range = await get<Overview>(db,
      `/analytics/overview?from=${preset.range.from}&to=${preset.range.to}&bucket=day`);
    assert.equal(range.summary.spend, preset.summary.spend, "explicit range vs preset (spend)");
    assert.equal(range.summary.income, preset.summary.income, "explicit range vs preset (income)");
    assert.equal(range.summary.n, preset.summary.n, "explicit range vs preset (count)");
  } finally { restore(); }
});
