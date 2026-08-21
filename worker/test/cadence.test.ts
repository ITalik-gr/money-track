/**
 * §CADENCE — the rule that decides whether a period-over-period delta is a finding.
 *
 * These are pure-function tests on purpose. The rule used to live inline in `report.ts`, where it
 * was only ever exercised through a whole AI report; the two screens that needed it most had no
 * access to it at all. A rule that costs a fixture to test is a rule that gets re-derived by hand
 * at the next call site, which is exactly how it came to be missing from `/analytics/compare`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHORT_PERIOD_DAYS, isShortPeriod, periodDays, deltaMeaningful, buildCompare, type CompareSide,
} from "../lib/finance/cadence.ts";

const cat = (id: number, spent: number, n: number, name = `c${id}`): CompareSide =>
  ({ category_id: id, category_name: name, color: null, spent, n });

test("a window shorter than a billing cycle cannot compare a monthly charge", () => {
  assert.equal(isShortPeriod(7), true);
  assert.equal(isShortPeriod(SHORT_PERIOD_DAYS), false);
  // The reported bug verbatim: one charge this week against one last week is «−92%».
  assert.equal(deltaMeaningful(7, 1, 1), false);
  // Two on both sides means the category really does bill more often than the window.
  assert.equal(deltaMeaningful(7, 2, 2), true);
  // Two against one is still timing — the 30-day window straddled two billing dates.
  assert.equal(deltaMeaningful(7, 2, 1), false);
});

test("a full month or longer compares whatever it finds", () => {
  // Above the threshold a monthly biller is present on both sides by construction, so even a
  // single charge each way is a comparison of amounts rather than of calendars.
  assert.equal(deltaMeaningful(31, 1, 1), true);
  assert.equal(deltaMeaningful(31, 1, 0), true);
});

test("a category that stopped is not a percentage", () => {
  // 2 → 0 in a short window is muted too. That is deliberate: the honest thing to say is
  // «зникло», which the UI renders as a word, not as −100%.
  assert.equal(deltaMeaningful(7, 0, 2), false);
});

test("periodDays counts the window the period rules count", () => {
  assert.equal(periodDays(0, 7 * 86400), 7);
  assert.equal(periodDays(0, 0), 1); // never zero — it is a divisor elsewhere
});

test("buildCompare merges both windows and keeps a vanished category visible", () => {
  const a = [cat(1, 30000, 6), cat(2, 5000, 1)];
  const b = [cat(1, 20000, 5), cat(3, 90000, 1, "rent")];
  const { rows } = buildCompare(a, b, { days: 30, floor: 5000 });

  assert.equal(rows.length, 3);
  // Sorted by the BIGGER side, so the category that disappeared leads — it is the answer to
  // «що змінилось», and sorting by the current period alone would bury it last.
  assert.equal(rows[0].category_id, 3);
  assert.deepEqual([rows[0].a, rows[0].b, rows[0].delta], [0, 90000, -90000]);
  // A row seen only in B still carries its name and colour, which come from the B side.
  assert.equal(rows[0].category_name, "rent");
  const one = rows.find((r) => r.category_id === 1)!;
  assert.deepEqual([one.a, one.b, one.n, one.prev_n], [30000, 20000, 6, 5]);
});

test("movers respect the noise floor AND the cadence rule", () => {
  // `rent` moved by 900 ₴ — by far the biggest number on the screen — but it is one charge
  // against zero inside a week. That is the whole bug: the loudest row was the false one.
  const a = [cat(1, 30000, 6), cat(2, 5100, 3)];
  const b = [cat(1, 20000, 5), cat(2, 100, 2), cat(3, 90000, 1, "rent")];
  const { movers } = buildCompare(a, b, { days: 7, floor: 5000 });

  assert.deepEqual(movers.up.map((r) => r.category_id), [1, 2]);
  assert.deepEqual(movers.down.map((r) => r.category_id), []);
});

test("the floor is applied to the value it is given, not to a hardcoded one", () => {
  // §BASE-CUR: the caller converts 50 ₴ into the reader's base. A row of 60 units clears a floor
  // of 50 and does not clear a floor of 5000 — which is precisely the difference between the
  // owner reading hryvnia and someone reading dollars against the same literal.
  const a = [cat(1, 6000, 4)];
  const b = [cat(1, 0, 4)];
  assert.equal(buildCompare(a, b, { days: 30, floor: 5000 }).movers.up.length, 1);
  assert.equal(buildCompare(a, b, { days: 30, floor: 50000 }).movers.up.length, 0);
});

test("a non-meaningful row is still RETURNED, only demoted out of the movers", () => {
  const { rows, movers } = buildCompare([cat(1, 90000, 1)], [], { days: 7, floor: 5000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta_meaningful, false);
  // Hiding it would hide 900 ₴ of real spending; the screen shows the money and mutes the claim.
  assert.equal(movers.up.length, 0);
});
