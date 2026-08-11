/**
 * §GOAL-PACE — "is this goal going to make it".
 *
 * The function exists because the answer used to be computed twice: once in `Goals.tsx` (the
 * monthly rate on the card) and once in `draftGoalRisk` (the monthly rate in the notification),
 * with different month lengths and only the second one having any notion of falling behind. The
 * tests below are therefore about the THRESHOLDS and the sprint rule — the parts a second
 * implementation would have got subtly wrong, and the parts a reader has to be able to trust,
 * since "behind" is an accusation the app makes about the user's saving.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { goalPace, goalNeedsAttention } from "../lib/finance/goals.ts";

const NOW = Math.floor(new Date("2026-05-14T09:00:00.000Z").getTime() / 1000);
const DAY = 86400;

/** A goal opened 100 days ago, due in `dueDays`, with `saved` of 100 000 (in minor units). */
const goal = (saved: number, dueDays: number | null, openedDaysAgo = 100) => ({
  target_amount: 100_000,
  current: saved,
  deadline: dueDays == null ? null : NOW + dueDays * DAY,
  created_at: NOW - openedDaysAgo * DAY,
});

test("goal pace: a reached target is done, whatever the calendar says", () => {
  // Even past its deadline. The goal is met; calling that "past due" would be false and unkind.
  const p = goalPace(goal(100_000, -30), NOW);
  assert.equal(p.status, "done");
  assert.equal(p.left, 0);
  assert.equal(p.per_month, null);
  assert.equal(goalNeedsAttention(p), false);
});

test("goal pace: no deadline means no pace at all", () => {
  const p = goalPace(goal(20_000, null), NOW);
  assert.equal(p.status, "no_deadline");
  // Not "on track" — there is nothing to be on track FOR, and a green badge would be a claim.
  assert.equal(p.elapsed_frac, null);
  assert.equal(p.behind_frac, null);
  assert.equal(p.per_month, null);
  assert.equal(goalNeedsAttention(p), false);
});

test("goal pace: money keeping up with time is on track", () => {
  // 100 days in, 100 to go: half the window gone. Half the money saved.
  const p = goalPace(goal(50_000, 100), NOW);
  assert.equal(p.status, "on_track");
  assert.equal(Math.round((p.elapsed_frac ?? 0) * 100), 50);
  assert.ok(Math.abs(p.behind_frac ?? 1) < 0.01);
  assert.equal(goalNeedsAttention(p), false);
});

test("goal pace: the behind threshold is a gap of 15 points, not any gap", () => {
  // Half the window gone, 40% saved — a 10-point gap. Real, but within the noise of any month
  // where one contribution lands late; calling it "behind" every time would train the user to
  // ignore the badge.
  assert.equal(goalPace(goal(40_000, 100), NOW).status, "on_track");
  // 33% saved against 50% elapsed — a 17-point gap.
  const behind = goalPace(goal(33_000, 100), NOW);
  assert.equal(behind.status, "behind");
  assert.equal(goalNeedsAttention(behind), true);
});

test("goal pace: the last week is at risk even when the money is on schedule", () => {
  // 96% saved with 5 days left is not "behind" by the gap rule — and it still deserves saying,
  // because at this point the question stops being "are you keeping up" and becomes "will you
  // make it".
  const p = goalPace(goal(96_000, 5), NOW);
  assert.equal(p.status, "at_risk");
  assert.equal(goalNeedsAttention(p), true);
});

test("goal pace: a passed deadline with money still missing is overdue", () => {
  const p = goalPace(goal(60_000, -3), NOW);
  assert.equal(p.status, "overdue");
  assert.ok((p.days_left ?? 0) < 0);
  assert.equal(goalNeedsAttention(p), true);
});

test("goal pace: the monthly rate is the remainder over the months left", () => {
  // 40 000 still needed, ~3.29 months to the deadline (100 days / 30.44).
  const p = goalPace(goal(60_000, 100), NOW);
  assert.equal(p.left, 40_000);
  assert.equal(p.per_month, Math.round(40_000 / (100 / 30.44)));
});

test("goal pace: under a month there is NO monthly rate", () => {
  // "Save 120 000 a month" with 20 days left is arithmetically true and practically nonsense.
  // The card and the notification both fall back on `left`, which is the only figure that means
  // anything here. (Decision of 2026-07-14, DESIGN §8 P5.)
  const p = goalPace(goal(20_000, 20), NOW);
  assert.equal(p.per_month, null);
  assert.equal(p.left, 80_000);
});

test("goal pace: progress cannot read over 100%, and the remainder cannot go negative", () => {
  // A jar-backed goal is fed by an account balance, which happily goes past the target.
  const p = goalPace(goal(150_000, 30), NOW);
  assert.equal(p.status, "done");
  assert.equal(p.progress_frac, 1);
  assert.equal(p.left, 0);
});

test("goal pace: a goal created after its own deadline still reports the deadline", () => {
  // Degenerate but reachable by editing a goal's dates. There is no window to measure elapsed
  // time against, so there is no gap to report — but the deadline itself is still a fact, and
  // dropping the goal from the feed (which is what the old code did) hid the one thing worth
  // saying about it.
  const p = goalPace({ target_amount: 100_000, current: 10_000, deadline: NOW - DAY, created_at: NOW }, NOW);
  assert.equal(p.elapsed_frac, null);
  assert.equal(p.behind_frac, null);
  assert.equal(p.status, "overdue");
  assert.equal(goalNeedsAttention(p), true);
});
