/**
 * §PCT-SUM — a composition's percentages add up to 100, whatever the parts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { wholePcts, pctOf } from "../../shared/pct.ts";

test("thirds sum to 100, not 99 — and the leftover goes to the biggest remainder", () => {
  assert.deepEqual(wholePcts([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(wholePcts([2, 1]), [67, 33]);
});

test("any set sums to exactly 100", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 500; k++) {
    const n = 1 + Math.floor(rnd() * 9);
    const parts = Array.from({ length: n }, () => Math.round(rnd() * 1_000_000));
    if (parts.every((p) => p === 0)) continue;
    const pct = wholePcts(parts);
    assert.equal(pct.reduce((s, v) => s + v, 0), 100, JSON.stringify(parts));
    // Never more than one point away from the exact share.
    const total = parts.reduce((s, v) => s + v, 0);
    pct.forEach((p, i) => assert.ok(Math.abs(p - (parts[i] / total) * 100) < 1, `${p} vs ${parts[i]}/${total}`));
  }
});

test("edges: all zero stays zero, one part is 100, a negative part counts by magnitude", () => {
  assert.deepEqual(wholePcts([0, 0]), [0, 0]);
  assert.deepEqual(wholePcts([5]), [100]);
  assert.deepEqual(wholePcts([-50, 50]), [50, 50]);
  assert.equal(pctOf(1, 0), null);
  assert.equal(pctOf(25, 100), 25);
});
