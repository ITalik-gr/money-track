/**
 * §WEEKDAY-HABIT — rent paid on a Sunday is a contract, not a Sunday habit (owner, 2026-09-25).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildWeekdayAnalytics, type WeekdayRow } from "../lib/finance/weekday.ts";

// 28 days = four of every weekday.
const FROM = Math.floor(Date.parse("2026-08-31T21:00:00Z") / 1000); // Mon 1 Sep, Kyiv midnight
const TO = FROM + 28 * 86400 - 1;
const row = (dow: number, spent: number, n: number, biggest: number): WeekdayRow => ({ dow, spent, n, biggest });

test("§WEEKDAY-HABIT: a lump on Sunday leaves Sunday's habit, the busiest day and the weekend share alone", () => {
  // Sunday: rent 12 500 + four small buys; every other day ~400 of small buys.
  const all = [0, 1, 2, 3, 4, 5, 6].map((d) => d === 0 ? row(0, 12_900_00, 5, 12_500_00) : row(d, 400_00, 4, 150_00));
  const wd = buildWeekdayAnalytics(all, FROM, TO, all);
  const sun = wd.days.find((d) => d.dow === 0)!;
  assert.equal(sun.lump, 12_500_00);
  assert.equal(sun.habit_typical, Math.round(400_00 / 4));
  assert.equal(wd.habit!.lumps, 12_500_00);
  // Full canon unchanged: the share with rent is dominated by Sunday…
  assert.ok(wd.weekend_share_pct! > 70);
  // …the habit share is not.
  assert.ok(wd.habit!.weekend_share_pct! <= 30, `habit weekend ${wd.habit!.weekend_share_pct}`);
});

test("§WEEKDAY-HABIT: plan-linked spend is reported as set aside, not silently dropped", () => {
  const all = [row(1, 1_000_00, 3, 400_00)];
  const unplanned = [row(1, 600_00, 2, 400_00)];
  const wd = buildWeekdayAnalytics(all, FROM, TO, unplanned);
  assert.equal(wd.habit!.planned, 400_00);
  // Without habit rows the payload is exactly the old one.
  assert.equal(buildWeekdayAnalytics(all, FROM, TO).habit, undefined);
});
