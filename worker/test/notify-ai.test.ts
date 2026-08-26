/**
 * The AI branch of the feed — the guards, not the model.
 *
 * All of these come from one screenshot on 2026-08-27. The feed carried, two days apart:
 *   • «Rent due in 11 days, cushion covers only 0.8 months total» — for rent paid on the 20th, by
 *     an app that was never told what day it is and has no scheduled row for rent at all;
 *   • «Cushion lasts 24 days at current burn» — the same thought as the first, in other words;
 *   • «Utilities bill jumped 53% above budget» — the same thought as the deterministic budget
 *     event sitting beside it;
 *   • English headlines over Ukrainian bodies, on a Ukrainian screen.
 * The calendar and language guards live in `grounding.test.ts`; repetition lives here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { repeatsRecentTopic } from "../lib/messaging/drafts-ai.ts";
import { buildTimeContext } from "../lib/ai/time-context.ts";

test("the same thought in other words is still the same thought", () => {
  const recent = ["Cushion lasts 24 days at current burn"];
  // Verbatim from the feed: different hash, same news, two days apart.
  assert.equal(repeatsRecentTopic("Rent due in 11 days, cushion covers only 0.8 months total", recent), true);
  assert.equal(repeatsRecentTopic("Комуналка тримається на 1 660 ₴/міс", recent), false);
});

test("the stoplist is what keeps one shared word from meaning everything repeats", () => {
  const recent = ["Комуналка зросла понад бюджет"];
  // Same subject, other words — a repeat, and deliberately so: the prompt asks for something NEW.
  assert.equal(repeatsRecentTopic("Комуналка знову дорожча за підписки", recent), true);
  // Shares only «бюджет», which names no topic — a different category is different news.
  assert.equal(repeatsRecentTopic("Продукти вибрали бюджет достроково", recent), false);
});

test("the model is given a calendar, and the anchors are exactly what it was given", () => {
  // 2026-08-27 12:00 Kyiv. The rent case: nothing about rent in `upcoming`, so nothing about rent
  // in the anchors — and `timeClaimsAreGrounded` therefore refuses any countdown to it.
  const now = Math.floor(Date.UTC(2026, 7, 27, 9, 0, 0) / 1000);
  const ctx = buildTimeContext(
    now,
    [{ in_days: 6, date: "2026-09-02" }, { in_days: 24, date: "2026-09-20" }],
    0.8,
    ["2026-07", "2026-08"],
  );
  assert.equal(ctx.fields.today, "2026-08-27");
  assert.equal(ctx.fields.day_of_month, 27);
  assert.equal(ctx.fields.runway_days, 24, "«lasts 24 days» must be a figure we handed over, not one derived by eye");
  assert.ok(ctx.anchors.days.includes(6) && ctx.anchors.days.includes(2), "in_days and the day-of-month of each charge");
  assert.ok(!ctx.anchors.days.includes(11), "the invented countdown has no anchor");
  // September is anchored because a charge falls in it; October is not, so "money ends before
  // October" cannot be said.
  assert.deepEqual([...new Set(ctx.anchors.months)].sort((a, b) => a - b), [6, 7, 8]);
});

test("no runway means no day count at all, rather than a zero", () => {
  const now = Math.floor(Date.UTC(2026, 7, 27, 9, 0, 0) / 1000);
  const ctx = buildTimeContext(now, [], null, []);
  assert.equal(ctx.fields.runway_days, null);
  // An empty schedule anchors only today, the days left in the month and the window lengths the
  // payload names itself — which is the honest reading of "we told it no schedule".
  assert.ok(!ctx.anchors.days.includes(11));
});
