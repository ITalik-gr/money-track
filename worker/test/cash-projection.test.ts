/**
 * §CASH-PROJ — the forecast tail of the cumulative-flow chart.
 *
 * Assertions rather than a golden, for the same reason as `recurring.test.ts`: every number here
 * is a policy, and a golden would only prove the policy stopped moving.
 *
 * The two that decide whether the feature is worth having are opposite failures, so both are
 * pinned:
 *
 *  · a scheduled charge must land on ITS day. Smearing it across the month is precisely what the
 *    old client-side median did, and the reason the owner called the line useless;
 *  · the TOTAL must not move. A projection free to change both the shape and the size cannot be
 *    checked against burn, runway or safe-to-spend, which all already agree on the size.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { projectDays, detectPaydays } from "../lib/finance/cash-projection.ts";
import { localDayStart } from "../lib/finance/time.ts";

const DAY = 86400;
/** Wednesday 3 June 2026, midday Kyiv — mid-week and mid-month, so no boundary hides an off-by-one. */
const NOW = Math.floor(Date.parse("2026-06-03T09:00:00Z") / 1000);

const FLAT_DOM = new Array(31).fill(0) as number[];
const FLAT_DOW = new Array(7).fill(0) as number[];

function project(over: Partial<Parameters<typeof projectDays>[0]> = {}) {
  return projectDays({
    after: NOW, until: NOW + 10 * DAY,
    scheduled: [], ordinaryDaily: 10_000, domProfile: FLAT_DOM, dowProfile: FLAT_DOW, paydays: [],
    ...over,
  });
}

test("§CASH-PROJ: with no shape at all it is the flat line — the old behaviour is the floor", () => {
  const days = project();
  assert.equal(days.length, 10);
  for (const d of days) assert.equal(d.ordinary, 10_000);
});

test("§CASH-PROJ: the shape moves, the total does not", () => {
  // A day-of-month profile that spends heavily on the 5th and lightly on the 10th.
  const dom = [...FLAT_DOM];
  dom[4] = 30_000;
  for (const i of [5, 6, 7, 8]) dom[i] = 10_000;
  dom[9] = 2_000;

  const flat = project();
  const shaped = project({ domProfile: dom });

  const sum = (rows: { ordinary: number }[]) => rows.reduce((s, r) => s + r.ordinary, 0);
  // Within rounding of one unit per day: the weights are normalised, not merely applied.
  assert.ok(Math.abs(sum(shaped) - sum(flat)) <= shaped.length,
    `total moved: ${sum(shaped)} vs ${sum(flat)}`);

  const on = (dayOfMonth: number) => shaped.find((d) => d.date.endsWith(`-${String(dayOfMonth).padStart(2, "0")}`))!;
  assert.ok(on(5).ordinary > on(10).ordinary, "the 5th must be projected heavier than the 10th");
});

test("§CASH-PROJ: one enormous history day cannot promise a catastrophe (weights are clamped)", () => {
  const dom = [...FLAT_DOM];
  dom[4] = 5_000_000;            // one car repair, filed on the 5th
  for (const i of [5, 6, 7, 8, 9]) dom[i] = 10_000;
  const days = project({ domProfile: dom });
  const fifth = days.find((d) => d.date.endsWith("-05"))!;
  // 2.5× an average day, never 500×.
  assert.ok(fifth.ordinary <= 10_000 * 2.5 * 1.5, `unclamped spike: ${fifth.ordinary}`);
});

test("§CASH-PROJ: a scheduled charge lands on ITS day, not spread across the month", () => {
  const at = localDayStart(NOW + 4 * DAY);
  const days = project({ scheduled: [{ at, amount: 120_000 }] });
  const hit = days.filter((d) => d.scheduled > 0);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.at, at);
  assert.equal(hit[0]!.scheduled, 120_000);
});

test("§CASH-PROJ: an inflow is a NEGATIVE scheduled amount and comes back as income", () => {
  const at = localDayStart(NOW + 2 * DAY);
  const days = project({ scheduled: [{ at, amount: -450_000 }] });
  const hit = days.find((d) => d.income > 0)!;
  assert.equal(hit.at, at);
  assert.equal(hit.income, 450_000);
  assert.equal(hit.scheduled, 0);
});

test("§CASH-PROJ: a dated income plan wins over a detected payday on the same day", () => {
  const at = localDayStart(NOW + 2 * DAY);
  // The day-of-month is read off the projection's OWN calendar, not off a UTC ISO string: Kyiv
  // midnight is 21:00 the previous day in UTC, so the naive reading names the day before and the
  // test would pass while proving the opposite of its title.
  const dom = Number(project().find((d) => d.at === at)!.date.slice(8));
  const days = project({ scheduled: [{ at, amount: -450_000 }], paydays: [{ dom, amount: 400_000 }] });
  const hit = days.find((d) => d.income > 0)!;
  // 450 000, never 850 000: one salary counted twice on the day it is most likely to be right.
  assert.equal(hit.income, 450_000);
  assert.equal(days.filter((d) => d.income > 0).length, 1);
});

test("§CASH-PROJ: a detected payday appears on its day of the month", () => {
  const days = projectDays({
    after: NOW, until: NOW + 40 * DAY, scheduled: [], ordinaryDaily: 1_000,
    domProfile: FLAT_DOM, dowProfile: FLAT_DOW, paydays: [{ dom: 15, amount: 900_000 }],
  });
  const paid = days.filter((d) => d.income > 0);
  assert.ok(paid.length >= 1);
  for (const d of paid) {
    assert.ok(d.date.endsWith("-15"), `payday on ${d.date}`);
    assert.equal(d.income, 900_000);
  }
});

test("§CASH-PROJ: a period already over projects nothing", () => {
  assert.deepEqual(projectDays({
    after: NOW, until: NOW - DAY, scheduled: [], ordinaryDaily: 10_000,
    domProfile: FLAT_DOM, dowProfile: FLAT_DOW, paydays: [],
  }), []);
});

test("§CASH-PROJ paydays: rhythm plus median, never a single sighting", () => {
  const rows = [
    { ym: "2026-01", dom: 5, income: 4_500_00 },
    { ym: "2026-02", dom: 5, income: 4_500_00 },
    { ym: "2026-03", dom: 5, income: 9_000_00 },   // one bonus month
    { ym: "2026-04", dom: 5, income: 4_500_00 },
    { ym: "2026-04", dom: 22, income: 300_00 },    // one refund, once
  ];
  const found = detectPaydays(rows);
  assert.deepEqual(found.map((p) => p.dom), [5], "a one-off arrival is not a payday");
  // The MEDIAN, so one bonus does not become the expectation.
  assert.equal(found[0]!.amount, 4_500_00);
});

test("§CASH-PROJ paydays: two months is a coincidence, not a rhythm", () => {
  assert.deepEqual(detectPaydays([
    { ym: "2026-03", dom: 5, income: 4_500_00 },
    { ym: "2026-04", dom: 5, income: 4_500_00 },
  ]), []);
});

test("§CASH-PROJ paydays: a day present in a minority of months is refused", () => {
  const rows = [
    ...["2026-01", "2026-02", "2026-03"].map((ym) => ({ ym, dom: 7, income: 100_00 })),
    ...["2026-04", "2026-05", "2026-06", "2026-07"].map((ym) => ({ ym, dom: 20, income: 5_000_00 })),
  ];
  // The 7th appears in 3 of 7 months (43%), below the 60% share a payday has to clear.
  assert.deepEqual(detectPaydays(rows).map((p) => p.dom), [20]);
});
