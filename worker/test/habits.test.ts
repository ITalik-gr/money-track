/**
 * §HABITS — unit tests for the thresholds that decide what counts as a habit.
 *
 * A unit test rather than a golden, deliberately. The shared read fixture has no merchant with a
 * start-then-continue shape, so `/analytics/habits` returns two empty lists against it — a green
 * test that proves nothing. Seeding one into `fixture.ts` would move every other analytics golden,
 * and a churned baseline is one nobody reads (the lesson recorded in ARCHITECTURE §Phase 0c).
 *
 * `buildHabits` is pure, so the thresholds — the only part where a judgement was made — can be
 * exercised directly, one rule per case. The golden still covers the endpoint's empty shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHabits, type MerchantMonthRow } from "../lib/finance/habits.ts";
import { localYm, localMonthStart } from "../lib/finance/stats.ts";

// Mid-month so nothing depends on a boundary; §HABITS only ever looks at COMPLETE months anyway.
const NOW = Math.floor(Date.parse("2026-05-14T12:00:00+03:00") / 1000);

/** `monthsAgo` complete months back: 1 = last complete month. */
const ym = (monthsAgo: number) => localYm(localMonthStart(NOW, -monthsAgo));

function row(merchant: string, monthsAgo: number, spent: number): MerchantMonthRow {
  return { merchant, ym: ym(monthsAgo), spent, n: 1 };
}

test("§HABITS: a merchant charged in 2 of the last 3 months, and never before, is NEW", () => {
  const r = buildHabits([row("Netflix", 1, 30_000), row("Netflix", 2, 30_000)], NOW);
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0]!.merchant, "Netflix");
  assert.equal(r.started[0]!.months, 2);
  assert.equal(r.started[0]!.monthly, 30_000, "average over the months actually charged");
  assert.equal(r.stopped.length, 0);
});

test("§HABITS: ONE month is a purchase, not a habit", () => {
  // The whole reason the threshold is two: a single charge is indistinguishable from buying a
  // thing once, and a list that reports every one-off purchase as a new subscription is noise.
  const r = buildHabits([row("Rozetka", 1, 500_000)], NOW);
  assert.deepEqual(r.started, []);
});

test("§HABITS: a merchant that was already being charged earlier is NOT new", () => {
  const r = buildHabits(
    [row("Spotify", 1, 20_000), row("Spotify", 2, 20_000), row("Spotify", 4, 20_000)],
    NOW,
  );
  assert.deepEqual(r.started, [], "it was charged 4 months ago — it is not a newcomer");
});

test("§HABITS: regular for 3+ months then silent for 2 complete months is STOPPED", () => {
  const r = buildHabits(
    [row("Gym", 3, 80_000), row("Gym", 4, 80_000), row("Gym", 5, 80_000)],
    NOW,
  );
  assert.equal(r.stopped.length, 1);
  assert.equal(r.stopped[0]!.merchant, "Gym");
  assert.equal(r.stopped[0]!.months, 3);
  assert.equal(r.stopped[0]!.last, ym(3));
});

test("§HABITS: one month of silence is not enough — a billing cycle can slip", () => {
  // Two months is longer than any monthly cycle, so silence means cancelled or failed rather
  // than "charged on the 2nd instead of the 30th".
  const r = buildHabits(
    [row("Gym", 2, 80_000), row("Gym", 3, 80_000), row("Gym", 4, 80_000)],
    NOW,
  );
  assert.deepEqual(r.stopped, [], "charged in the second-to-last complete month");
});

test("§HABITS: an occasional merchant that goes quiet is not 'stopped'", () => {
  const r = buildHabits([row("Кафе", 4, 15_000), row("Кафе", 6, 15_000)], NOW);
  assert.deepEqual(r.stopped, [], "2 of 6 months is not a habit to begin with");
});

test("§HABITS: the current partial month is ignored on both sides", () => {
  // A merchant charged every month INCLUDING the current one must not read as stopped just
  // because the month is not over. `ym(0)` is today's month.
  const rows: MerchantMonthRow[] = [0, 1, 2, 3, 4].map((m) => ({
    merchant: "Комуналка", ym: localYm(localMonthStart(NOW, -m)), spent: 100_000, n: 1,
  }));
  const r = buildHabits(rows, NOW);
  assert.deepEqual(r.stopped, []);
  assert.deepEqual(r.started, [], "and it is not new either — it ran before the window");
});

test("§HABITS: the total is what the newcomers add per month, and the list is biggest-first", () => {
  const r = buildHabits([
    row("Small", 1, 10_000), row("Small", 2, 10_000),
    row("Big", 1, 90_000), row("Big", 2, 90_000),
  ], NOW);
  assert.deepEqual(r.started.map((h) => h.merchant), ["Big", "Small"]);
  assert.equal(r.started_monthly_total, 100_000);
});

// ---- already answered for (2026-08-12) --------------------------------------------------------
// The list became actionable: a row can be turned into a plan or dismissed as "not a subscription".
// Both write somewhere the detector must then respect, or the row survives its own action and the
// click reads as "nothing happened".

test("§HABITS: a merchant already declared as a plan is not reported as new", () => {
  const known = new Set(["netflix"]);
  const r = buildHabits([row("Netflix", 1, 30_000), row("Netflix", 2, 30_000)], NOW, known);
  assert.deepEqual(r.started, []);
  // And the total follows: it is what the newcomers add, so a known merchant must not inflate it.
  assert.equal(r.started_monthly_total, 0);
});

test("§HABITS: the match is case-insensitive, because the two sources disagree on case", () => {
  // `declaredTitles` lower-cases; merchants arrive from the bank in whatever case it sends.
  const r = buildHabits([row("NETFLIX", 1, 30_000), row("NETFLIX", 2, 30_000)], NOW, new Set(["netflix"]));
  assert.deepEqual(r.started, []);
});

test("§HABITS: a declared plan going quiet is not reported here either", () => {
  // `dead_sub` in notify.ts already says exactly this about declared plans. Two features
  // reporting one fact in different words is how a user learns to distrust both.
  const rows = [row("Gym", 3, 80_000), row("Gym", 4, 80_000), row("Gym", 5, 80_000)];
  assert.deepEqual(buildHabits(rows, NOW, new Set(["gym"])).stopped, []);
  // Sanity: without the exclusion this very fixture DOES report it, so the test above is not
  // passing for some unrelated reason.
  assert.equal(buildHabits(rows, NOW).stopped.length, 1);
});

test("§HABITS: an unknown merchant is unaffected by the exclusion set", () => {
  const r = buildHabits([row("Spotify", 1, 20_000), row("Spotify", 2, 20_000)], NOW, new Set(["netflix"]));
  assert.deepEqual(r.started.map((h) => h.merchant), ["Spotify"]);
});
