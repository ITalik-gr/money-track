/**
 * §WEEKDAY and its day-of-month twin — the calendar SHAPE of spending.
 *
 * Neither half had a unit test; both were covered only by the golden snapshots, which pin what the
 * endpoint returns and cannot say whether it is right. That gap is why a second, worse copy of the
 * weekday split survived in `StatsTrends.tsx` for months: nothing stated the rules in a form that
 * would fail when they were broken.
 *
 * The two rules, in both axes:
 *
 *  1. **Divide by how many such days the window held.** A month has five Fridays and four
 *     Saturdays, three 15ths and two 31sts. Comparing raw sums reports the calendar as behaviour.
 *  2. **A day carried by ONE payment is not a day.** Rent on the 1st makes the 1st the day rent
 *     is due, not an expensive day.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  weekdayCounts, buildWeekdayAnalytics, domCounts, buildDomAnalytics,
  type WeekdayRow, type DomRow,
} from "../lib/finance/weekday.ts";

/** Kyiv is UTC+3 in summer, so a local day starts at 21:00 UTC the day before. */
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("domCounts counts LOCAL dates, and short months are honest about it", () => {
  // 1 Mar – 30 Apr inclusive: every date 1..30 twice, the 31st once (March only).
  const counts = domCounts(at("2026-03-01T00:00:00+02:00"), at("2026-04-30T23:59:59+03:00"));
  assert.equal(counts[0], 2);    // the 1st
  assert.equal(counts[29], 2);   // the 30th
  assert.equal(counts[30], 1);   // the 31st — March has one, April none
});

test("a February window simply has no 30th, and dividing by zero is not attempted", () => {
  const counts = domCounts(at("2026-02-01T00:00:00+02:00"), at("2026-02-28T23:59:59+02:00"));
  assert.equal(counts[29], 0);
  const a = buildDomAnalytics([], at("2026-02-01T00:00:00+02:00"), at("2026-02-28T23:59:59+02:00"));
  assert.equal(a.days[29].typical, 0);
  assert.equal(a.days.length, 31);   // always 31 rows, so the heat map has a stable grid
});

test("typical divides by occurrences — the whole reason this is not a raw sum", () => {
  const from = at("2026-03-01T00:00:00+02:00"), to = at("2026-04-30T23:59:59+03:00");
  const rows: DomRow[] = [
    // The 1st was hit twice for 200 total; the 31st once for 150. Raw sums say the 1st is dearer.
    { dom: 1, spent: 20000, n: 6, biggest: 4000 },
    { dom: 31, spent: 15000, n: 5, biggest: 4000 },
  ];
  const a = buildDomAnalytics(rows, from, to);
  assert.equal(a.days[0].typical, 10000);    // 200 over two 1sts
  assert.equal(a.days[30].typical, 15000);   // 150 over one 31st — actually the dearer date
  assert.equal(a.busiest, 31);
});

test("a date carried by one payment is not the busiest date", () => {
  const from = at("2026-03-01T00:00:00+02:00"), to = at("2026-03-31T23:59:59+03:00");
  const rows: DomRow[] = [
    // Rent: one operation, the whole sum. Loud, and not a habit.
    { dom: 1, spent: 1500000, n: 1, biggest: 1500000 },
    { dom: 14, spent: 50000, n: 8, biggest: 12000 },
  ];
  const a = buildDomAnalytics(rows, from, to);
  assert.equal(a.days[0].lumpy, true);
  assert.equal(a.busiest, 14);
});

test("first_five_share_pct is the part of the month already committed", () => {
  const from = at("2026-03-01T00:00:00+02:00"), to = at("2026-03-31T23:59:59+03:00");
  const rows: DomRow[] = [
    { dom: 1, spent: 60000, n: 2, biggest: 30000 },
    { dom: 3, spent: 20000, n: 3, biggest: 8000 },
    { dom: 20, spent: 20000, n: 4, biggest: 6000 },
  ];
  assert.equal(buildDomAnalytics(rows, from, to).first_five_share_pct, 80);
  // Nothing spent is not "0% committed" — it is no answer at all.
  assert.equal(buildDomAnalytics([], from, to).first_five_share_pct, null);
});

test("the weekday half obeys the same two rules", () => {
  // 1 Mar 2026 is a Sunday; 1 Mar – 14 Mar is exactly two of each weekday.
  const from = at("2026-03-01T00:00:00+02:00"), to = at("2026-03-14T23:59:59+02:00");
  assert.deepEqual(weekdayCounts(from, to), [2, 2, 2, 2, 2, 2, 2]);

  const rows: WeekdayRow[] = [
    { dow: 0, spent: 1000000, n: 1, biggest: 1000000 },   // one big Sunday payment
    { dow: 5, spent: 60000, n: 9, biggest: 12000 },       // Fridays, spread out
  ];
  const a = buildWeekdayAnalytics(rows, from, to);
  assert.equal(a.days[0].lumpy, true);
  assert.equal(a.busiest, 5);
  assert.equal(a.days[5].typical, 30000);
});
