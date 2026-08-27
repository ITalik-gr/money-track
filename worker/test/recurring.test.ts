/**
 * §SUB-DETECT — which repeated charges become a proposed subscription.
 *
 * Assertions, not a golden: every threshold in `recurring.ts` is a policy someone could have
 * chosen differently, and a golden would only prove the numbers stopped moving. The two that
 * decide whether the feature is worth having at all are opposite failures, so both are pinned:
 *
 *  · a foreign-currency subscription — a different amount EVERY month — must be found. The old
 *    `GROUP BY merchant, amount` could not see one, which meant it missed most of the owner's;
 *  · a grocery shop — many charges, many prices — must NOT be. The first draft of the fix
 *    proposed «Сільпо» three times over, one per price bucket, which is worse than the bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recurringCandidates, chargeRhythm, type ChargeRow } from "../lib/finance/recurring.ts";

const DAY = 86400;
const NOW = Math.floor(Date.parse("2026-08-27T09:00:00Z") / 1000);

/** N charges walking BACK from `now`, `everyDays` apart, each amount taken from `amounts`. */
function series(
  merchant: string, amounts: number[], everyDays: number,
  o: { currency?: number; category?: number | null; from?: number } = {},
): ChargeRow[] {
  const start = o.from ?? NOW - DAY;
  return amounts.map((amount, i) => ({
    merchant, amount,
    time: start - i * everyDays * DAY,
    currency_code: o.currency ?? 980,
    category_id: o.category ?? null,
  }));
}

test("a subscription billed in a FOREIGN currency is detected — the case the old rule could not see", () => {
  // Claude at ~$20: settled in hryvnia at the day's rate, so the amount differs every single
  // month. `GROUP BY merchant, amount` gave each charge its own group with n = 1 and dropped
  // them all at `HAVING n >= 2` — the feature was blind to exactly what it exists for.
  const rows = series("Claude.ai", [107_000, 106_200, 108_400, 105_900, 107_800], 30);
  const [c, ...rest] = recurringCandidates(rows, NOW);
  assert.equal(rest.length, 0, "one merchant, one proposal");
  assert.equal(c.merchant, "Claude.ai");
  assert.equal(c.n, 5);
  assert.equal(c.avg_interval_days, 30);
  // The MEDIAN charge, not the mean and not the latest: a declared price should survive one FX
  // spike, and the latest charge is the one most likely to be it.
  assert.equal(c.amount, 107_000);
});

test("a grocery shop is NOT a subscription, however many charges it has", () => {
  // Twelve visits at whatever the basket cost. Several ±10% buckets form by chance, and a couple
  // of them will have plausible gaps — which is precisely how the first draft produced three
  // «Сільпо» proposals. BUCKET_DOMINANCE is what refuses them: no single price owns the merchant.
  const amounts = [30_000, 31_200, 48_000, 52_500, 33_100, 79_000, 41_000, 42_900, 65_000, 30_800, 47_200, 51_000];
  const rows = amounts.map((amount, i) => ({
    merchant: "Сільпо", amount, time: NOW - (i * 14 + 1) * DAY, currency_code: 980, category_id: 1,
  }));
  assert.deepEqual(recurringCandidates(rows, NOW), []);
});

test("rhythm is measured — the same price at random times is not a schedule", () => {
  // One price, so the dominance rule passes; the GAPS are what disqualify it. This is the case
  // exact-amount matching used to wave through: a coffee that happens to cost the same.
  const times = [1, 3, 40, 44, 96, 99, 101, 160];
  const rows: ChargeRow[] = times.map((d) => ({
    merchant: "Кавʼярня", amount: 6_500, time: NOW - d * DAY, currency_code: 980, category_id: 2,
  }));
  assert.deepEqual(recurringCandidates(rows, NOW), []);
});

test("merchant spellings merge — «X Corp.» and «X Corp» are one subscription", () => {
  const rows: ChargeRow[] = [
    { merchant: "X Corp.", amount: 11_600, time: NOW - 2 * DAY, currency_code: 980, category_id: 5 },
    { merchant: "X CORP", amount: 11_500, time: NOW - 32 * DAY, currency_code: 980, category_id: 5 },
    { merchant: "X Corp", amount: 11_700, time: NOW - 62 * DAY, currency_code: 980, category_id: 5 },
  ];
  const out = recurringCandidates(rows, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].n, 3);
  // The longest spelling, because «X» is not a name a person recognises and the core token
  // («corp») is not a merchant at all.
  assert.equal(out[0].merchant, "X Corp.");
  assert.equal(out[0].category_id, 5);
});

test("one merchant billing in TWO currencies is two proposals, never one averaged", () => {
  // A plan carries ONE currency (§CUR-PLAN). Averaging $9.99 with 400 ₴ would produce a number
  // that is not a price in either of them.
  const rows = [
    ...series("Apple", [999, 999, 999], 30, { currency: 840 }),
    ...series("Apple", [40_000, 40_100, 39_900], 30, { currency: 980 }),
  ];
  const out = recurringCandidates(rows, NOW);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.currency_code).sort(), [840, 980]);
});

test("a single charge, or one month, proposes nothing", () => {
  // Two points make one gap, and a charge repeated inside ONE month is a habit, not a schedule
  // — the §APP_TZ note on `months` guards the other half of this.
  assert.deepEqual(recurringCandidates(series("Netflix", [30_000], 30), NOW), []);
  const sameMonth: ChargeRow[] = [
    { merchant: "Netflix", amount: 30_000, time: NOW - 2 * DAY, currency_code: 980, category_id: null },
    { merchant: "Netflix", amount: 30_000, time: NOW - 9 * DAY, currency_code: 980, category_id: null },
  ];
  assert.deepEqual(recurringCandidates(sameMonth, NOW), []);
});

test("cadence bounds: daily is a habit, half-yearly is out of window", () => {
  // Daily — the same lunch every day for two months. One price, perfect rhythm, and not a
  // subscription: MIN_INTERVAL_DAYS is the only thing that separates them.
  const daily = series("Stolovaya", Array.from({ length: 40 }, () => 12_000), 1);
  assert.deepEqual(recurringCandidates(daily, NOW), []);
  // 180-day gaps: within the read window, but past MAX_INTERVAL_DAYS. Two purchases half a year
  // apart are not distinguishable from a schedule with the data we have.
  assert.deepEqual(recurringCandidates(series("Insurance", [500_000, 500_000], 180), NOW), []);
});

test("a quarterly plan IS proposed — 90-day gaps are inside the window", () => {
  const out = recurringCandidates(series("PlayStation Plus", [105_000, 104_000, 106_000], 91), NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].avg_interval_days, 91);
});

test("a retried payment does not break the rhythm", () => {
  // A failed charge retried three days later is real, and a schedule that rejects it would drop
  // the subscription for the month it was needed most. GAP_SPREAD_MAX is sized for this.
  const rows: ChargeRow[] = [3, 33, 60, 93].map((d, i) => ({
    merchant: "Spotify", amount: 22_200 + i, time: NOW - d * DAY, currency_code: 980, category_id: 6,
  }));
  assert.equal(recurringCandidates(rows, NOW).length, 1);
});

/**
 * §RHYTHM — the pacing of a series, which the subscription page used to compute itself.
 *
 * The bug the owner reported, exactly: Apple bills on the 6th of every month and the page said
 * «кожні ~41 дн», with a warning that the rhythm had drifted. Five charges existed; four were
 * linked to the plan. `(last − first) / (n − 1)` over Apr 6 → Aug 6 with three gaps is 40.7.
 */
/** The 6th of each listed month, at Kyiv noon. */
const sixths = (...months: [number, number][]): number[] =>
  months.map(([y, m]) => Math.floor(Date.UTC(y, m - 1, 6, 9, 0, 0) / 1000));

test("§RHYTHM: one missing charge does NOT turn a monthly plan into 41 days", () => {
  // Apr, May, Jun, Aug — July is the row that was never linked.
  const r = chargeRhythm(sixths([2026, 4], [2026, 5], [2026, 6], [2026, 8]));
  // The mean would be 41. The median of gaps 30, 31, 61 is 31 — the honest answer, and the one
  // that does not accuse a punctual biller of drifting.
  assert.equal(r.interval_days, 31);
  // And the fact the owner actually used to spot it: it always bills on the 6th.
  assert.equal(r.day_of_month, 6);
  // The hole is REPORTED rather than smoothed over: a charge that went missing is precisely the
  // one nobody goes looking for.
  assert.equal(r.skipped, 1);
});

test("§RHYTHM: an unbroken monthly series reports the day and no gaps", () => {
  const r = chargeRhythm(sixths([2026, 4], [2026, 5], [2026, 6], [2026, 7], [2026, 8]));
  assert.equal(r.day_of_month, 6);
  assert.equal(r.skipped, 0);
  assert.ok(r.interval_days === 30 || r.interval_days === 31, `interval was ${r.interval_days}`);
});

test("§RHYTHM: a biller with no fixed day reports none", () => {
  // Every 14 days: a real cadence, but not a day of the month — printing one would be a claim the
  // data does not support.
  const start = Math.floor(Date.UTC(2026, 3, 2, 9, 0, 0) / 1000);
  const r = chargeRhythm([0, 14, 28, 42, 56].map((d) => start + d * DAY));
  assert.equal(r.day_of_month, null);
  assert.equal(r.interval_days, 14);
});

test("§RHYTHM: a day-early charge at a month boundary is still the same billing day", () => {
  // The 1st, posted on the 30th of the month before when the 1st is a weekend. Compared
  // circularly — a linear |1 − 30| would read 29 days apart and call a stable plan unstable.
  const t = [
    Math.floor(Date.UTC(2026, 4, 1, 9, 0, 0) / 1000),
    Math.floor(Date.UTC(2026, 4, 30, 9, 0, 0) / 1000),
    Math.floor(Date.UTC(2026, 6, 1, 9, 0, 0) / 1000),
  ];
  assert.equal(chargeRhythm(t).day_of_month, 1);
});

test("§RHYTHM: under two charges there is no rhythm to report", () => {
  assert.deepEqual(chargeRhythm([]), { interval_days: null, day_of_month: null, skipped: 0 });
  assert.deepEqual(chargeRhythm([1_780_000_000]), { interval_days: null, day_of_month: null, skipped: 0 });
});


/**
 * §AI-RECURRING — the model's guess, on the day the FIRST charge lands.
 *
 * The deterministic detector above is better evidence and cannot speak until the second month,
 * because a rhythm needs two points. By then the person has forgotten signing up. These two
 * scenarios pin the seam between them: a guess never replaces a measurement, and it is never
 * offered for something already declared.
 */
test("§AI-RECURRING: a single flagged charge becomes a LABELLED candidate", async () => {
  const { api } = await import("../routes/api/index.ts");
  const { migratedDb, testEnv, freezeTime } = await import("./harness.ts");
  const { seed, FROZEN_NOW_ISO } = await import("./fixture.ts");
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const at = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000) - 3 * DAY;
    db.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
         category_id, ai_recurring, created_at)
       VALUES ('nf-1', 'acc-uah', 'mono', ?, -30000, 980, 'Netflix', 1, 1, ?)`,
    ).run(at, at);

    const res = await api.request("/planned/detect", {}, testEnv(db) as never);
    assert.equal(res.status, 200);
    const rows = await res.json() as { merchant: string; ai?: boolean; n: number }[];
    const nf = rows.find((r) => r.merchant === "Netflix");
    assert.ok(nf, "the flagged charge is proposed after ONE occurrence");
    // Labelled, always: a rhythm measured in the ledger and a model's opinion are different kinds
    // of claim, and a row that hides which it is teaches the user to distrust both.
    assert.equal(nf.ai, true);
    assert.equal(nf.n, 1);
    // And the deterministic ones are NOT relabelled as guesses.
    assert.ok(rows.filter((r) => !r.ai).every((r) => r.n >= 2), "a measured candidate has ≥2 charges");
  } finally { restore(); }
});

test("§AI-RECURRING: a charge already tied to a plan is never proposed", async () => {
  const { api } = await import("../routes/api/index.ts");
  const { migratedDb, testEnv, freezeTime } = await import("./harness.ts");
  const { seed, FROZEN_NOW_ISO } = await import("./fixture.ts");
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const at = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000) - 3 * DAY;
    db.raw.prepare(
      "INSERT INTO planned_payments (id, title, kind, period_amount, period, start_date, is_active, currency_code, period_count) VALUES (91, 'Netflix', 'subscription', 30000, 'month', ?, 1, 980, 1)",
    ).run(at);
    db.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
         category_id, ai_recurring, planned_id, created_at)
       VALUES ('nf-2', 'acc-uah', 'mono', ?, -30000, 980, 'Netflix', 1, 1, 91, ?)`,
    ).run(at, at);

    const res = await api.request("/planned/detect", {}, testEnv(db) as never);
    const rows = await res.json() as { merchant: string }[];
    // Offering to create something that already exists is worse than offering nothing.
    assert.equal(rows.filter((r) => r.merchant === "Netflix").length, 0);
  } finally { restore(); }
});
