/**
 * §MERCH-QUIET — a merchant the user stopped paying carries no "per month" figure in the snapshot.
 *
 * The regression this pins: «You spend 1293 ₴/month on Preply» in the feed, 80 days after the last
 * Preply charge. The figure was 3878 / 3 — two June charges still inside the 90-day window. The
 * guard is the ABSENCE of that number, so the test checks it the way the feed does: through
 * `collectNumbers` + `numbersAreGrounded`, not by reading a field name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { merchantContext, QUIET_AFTER_DAYS } from "../lib/ai/merchant-context.ts";
import { collectNumbers, numbersAreGrounded } from "../lib/ai/grounding.ts";

const NOW = Date.UTC(2026, 8, 15) / 1000;
const DAY = 86400;

test("a merchant silent for longer than a cycle has no monthly figure to cite", () => {
  const ctx = merchantContext([{ merchant: "Preply", spent: 387_800, last_at: NOW - 78 * DAY }], NOW);
  assert.equal(ctx[0].stopped, true);
  assert.equal("per_month_90d_uah" in ctx[0], false);
  assert.equal(ctx[0].last_paid_days_ago, 78);

  const known = new Set<number>();
  collectNumbers(ctx, known);
  assert.equal(numbersAreGrounded("You spend 1293 ₴/month on Preply", known), false);
  // The real total is still citable — the fix hides a derived figure, not the history.
  assert.equal(numbersAreGrounded("3878 ₴ on Preply over 90 days", known), true);
});

test("a merchant still being paid keeps its 90-day-over-three figure", () => {
  const ctx = merchantContext([{ merchant: "Silpo", spent: 900_000, last_at: NOW - 2 * DAY }], NOW);
  assert.equal(ctx[0].per_month_90d_uah, 3000);
  assert.equal("stopped" in ctx[0], false);
});

test("the boundary is inclusive of the quiet window", () => {
  const at = (d: number) => merchantContext([{ merchant: "X", spent: 30_000, last_at: NOW - d * DAY }], NOW)[0];
  assert.equal("stopped" in at(QUIET_AFTER_DAYS), false);
  assert.equal(at(QUIET_AFTER_DAYS + 1).stopped, true);
});
