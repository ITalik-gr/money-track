/**
 * §PCT-SUM — whole percentages of a set that add up to exactly 100.
 *
 * Rounding each part on its own is how a legend reads «34% + 33% + 34% = 101%», or a donut of
 * seven slices sums to 98: every line looks right and the set is visibly wrong. The owner asked for
 * percentages beside the money on every composition (2026-09-25), which put this in front of him on
 * every screen at once — so there is ONE rule, largest remainder, and it is pinned by a test.
 *
 * Presentation only: the parts are whatever the server returned; nothing is recomputed. Parts are
 * taken as magnitudes (a refund-heavy slice is still a slice). All zero → all zero, not NaN.
 */
export function wholePcts(values: number[]): number[] {
  const abs = values.map((v) => Math.abs(v));
  const total = abs.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = abs.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((s, v) => s + v, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; out[o.i]++; left--; }
  return out;
}

/** One part's share of an explicit whole, as a whole percentage — for a part shown WITHOUT its siblings. */
export function pctOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((Math.abs(part) / whole) * 100) : null;
}
