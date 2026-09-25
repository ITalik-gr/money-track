/**
 * §HEALTH — the index's arithmetic, audited 2026-09-25 against the owner's question
 * «перевір чи реально формула норм, і чи працює вона».
 *
 * There was no test of the formula at all: the golden file pinned ONE score on ONE ledger, which
 * says the number did not change, never that it was right. The audit found two defects of the
 * §HEALTH-INCOME class — a missing thing graded as a good thing — and one presentation defect;
 * each has a test below that fails on the code before the fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scoreHealth, HEALTH_WEIGHTS, type HealthInputs } from "../lib/finance/health.ts";

const K = 100; // 1 ₴ in minor units
/** A steady, healthy person: 6 months of cushion, 25% savings, no debt, the same salary each month. */
const steady: HealthInputs = {
  cushion: 6 * 30_000 * K, burn: 30_000 * K, debt: 0,
  incomes: Array(6).fill(40_000 * K), spends: Array(6).fill(30_000 * K),
};
const part = (r: ReturnType<typeof scoreHealth>, k: string) => r.parts.find((p) => p.key === k)!;

test("the weights are a whole: 35 + 30 + 20 + 15 = 100", () => {
  const sum = Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

test("a steady, healthy ledger scores 100 — every part at full marks", () => {
  const r = scoreHealth(steady);
  assert.equal(r.score, 100);
  assert.equal(r.band, "good");
  assert.equal(r.insufficient, false);
  for (const p of r.parts) assert.equal(p.s, 1, p.key);
});

test("DEFECT 1 — no income at all is NOT perfectly stable income", () => {
  // Before: mean 0 → cv 0 → stability = 1 − 0 = 100%, and six jobless months earned 15 points.
  const r = scoreHealth({ ...steady, incomes: Array(6).fill(0) });
  assert.equal(part(r, "stability").s, 0);
  assert.equal(part(r, "stability").points, 0);
  assert.equal(part(r, "savings").s, 0, "six months with no income is a real zero, not missing data");
});

test("DEFECT 2 — one month cannot measure stability, and it is left OUT rather than graded", () => {
  // Before: a single value has no spread, so cv = 0 and stability read as a perfect 100%.
  const r = scoreHealth({ ...steady, incomes: [40_000 * K], spends: [30_000 * K] });
  assert.equal(part(r, "stability").s, null);
  assert.equal(part(r, "stability").points, 0);
  assert.equal(part(r, "stability").weight, 0);
  // The other three are renormalised over the 85% that WAS measured, so a perfect three still
  // reads 100 — the missing part neither helps nor hurts.
  assert.equal(r.score, 100);
});

test("DEFECT 2 — a brand-new account is provisional, not «risk» and not «good»", () => {
  const r = scoreHealth({ cushion: 0, burn: 0, debt: 0, incomes: [], spends: [] });
  assert.equal(part(r, "runway").s, null);
  assert.equal(part(r, "savings").s, null);
  assert.equal(part(r, "stability").s, null);
  assert.equal(r.insufficient, true, "only «no debt» is measurable — the score is a guess and says so");
});

test("DEFECT 3 — the parts' points ALWAYS add up to the score", () => {
  // The card rounded each part on its own; with these inputs the four printed points summed to one
  // more than the gauge. Sweep a grid of awkward fractions and demand an exact sum every time.
  for (let cushionM = 0; cushionM <= 7; cushionM += 0.7) {
    for (const saved of [-0.1, 0.03, 0.07, 0.13, 0.19, 0.31]) {
      for (const debtM of [0, 0.4, 1.3, 2.9]) {
        for (const wobble of [0, 0.11, 0.37, 0.8]) {
          const income = 40_000 * K;
          const incomes = [income, income * (1 - wobble), income * (1 + wobble), income, income * (1 - wobble / 2), income];
          const r = scoreHealth({
            cushion: cushionM * 30_000 * K, burn: 30_000 * K, debt: debtM * income,
            incomes, spends: incomes.map(() => income * (1 - saved)),
          });
          const sum = r.parts.reduce((s, p) => s + p.points, 0);
          assert.equal(sum, r.score, `cushion ${cushionM} saved ${saved} debt ${debtM} wobble ${wobble}`);
        }
      }
    }
  }
});

test("each part degrades sanely at its edges", () => {
  // Runway: 3 months of a 6-month target = half marks; 12+ caps at full.
  assert.equal(part(scoreHealth({ ...steady, cushion: 3 * 30_000 * K }), "runway").s, 0.5);
  assert.equal(part(scoreHealth({ ...steady, cushion: 20 * 30_000 * K }), "runway").s, 1);
  // Savings: 10% of a 20% target = half; spending more than you earn clamps at 0, never negative.
  const half = scoreHealth({ ...steady, spends: Array(6).fill(36_000 * K) });
  assert.equal(part(half, "savings").s, 0.5);
  const over = scoreHealth({ ...steady, spends: Array(6).fill(50_000 * K) });
  assert.equal(part(over, "savings").s, 0);
  // Debt: 1.5 months of income owed is half of the 3-month floor.
  assert.equal(part(scoreHealth({ ...steady, debt: 60_000 * K }), "debt").s, 0.5);
  assert.equal(part(scoreHealth({ ...steady, debt: 200_000 * K }), "debt").s, 0);
  // Stability: a spiky income (five empty months, one big payment) clamps at 0, never «−124%».
  const spiky = scoreHealth({ ...steady, incomes: [0, 0, 0, 0, 0, 240_000 * K] });
  assert.equal(part(spiky, "stability").s, 0);
});

test("the bands cut at 70 and 45", () => {
  const at = (score: number) => (score >= 70 ? "good" : score >= 45 ? "ok" : "risk");
  // Walk the runway to move the score and check the band always agrees with the cut points.
  for (let m = 0; m <= 6; m += 0.25) {
    const r = scoreHealth({ ...steady, cushion: m * 30_000 * K, spends: Array(6).fill(38_000 * K), debt: 80_000 * K });
    assert.equal(r.band, at(r.score), `score ${r.score}`);
  }
});

test("debt with no income history is unmeasured — not «three months of income»", () => {
  const r = scoreHealth({ cushion: 10_000 * K, burn: 5_000 * K, debt: 20_000 * K, incomes: [], spends: [] });
  assert.equal(part(r, "debt").s, null);
  // And debt with months of ZERO income is a real, bad answer.
  const jobless = scoreHealth({ cushion: 10_000 * K, burn: 5_000 * K, debt: 20_000 * K, incomes: [0, 0, 0], spends: [5_000 * K, 5_000 * K, 5_000 * K] });
  assert.equal(part(jobless, "debt").s, 0);
});
