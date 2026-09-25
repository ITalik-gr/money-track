/**
 * §SUB-DETECT / §RHYTHM — which repeated charges become a proposed subscription: a foreign-currency
 * plan (a different amount every month) is found, a grocery shop is not.
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
