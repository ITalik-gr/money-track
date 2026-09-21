/**
 * §PLAN-LATE — a scheduled payment is news only AFTER its date goes by.
 *
 * Bought by a real card: «Квартира відсутня в цьому місяці — 12500 ₴ очікується 20 числа … в
 * рахунках на сьогодні цього платежу немає», shipped on the 15th for rent due on the 20th. Nothing
 * in it was false; it was five days early, which for a warning about money is the same as wrong.
 *
 * Both directions are silent failures, which is why they are pinned here rather than eyeballed:
 * too eager and the feed cries about money that has not gone anywhere, too quiet and a rent that
 * genuinely did not leave the account is never mentioned at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { draftMissedPlans, lastDueUnix } from "../lib/messaging/drafts-plans.ts";
import { claimsMissingFutureCharge } from "../lib/ai/grounding.ts";
import { digestDue, clampHour } from "../lib/messaging/digest.ts";
import { infraDue, markInfraRan } from "../lib/platform/cron.ts";
import { migratedDirectoryDb } from "./harness.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const DAY = 86400;
const UAH = 980;

/** A monthly plan whose charge day is `dueDaysAgo` days behind `now`. */
function plan(db: MemDb, title: string, dueDaysAgo: number, now: number): number {
  db.raw.prepare(
    `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active,
       currency_code, period_count) VALUES (?, 'subscription', 12500_00, 'month', ?, 1, ?, 1)`,
  ).run(title, now - dueDaysAgo * DAY - 365 * DAY, UAH);
  const row = db.raw.prepare("SELECT id FROM planned_payments WHERE title = ?").get(title) as { id: number };
  return row.id;
}

/** A charge linked to that plan, `daysAgo` days back. */
function charge(db: MemDb, id: string, planId: number, daysAgo: number, now: number): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, created_at, planned_id)
     VALUES (?, 'acc-uah', 'manual', ?, -12500_00, 980, ?, ?)`,
  ).run(id, now - daysAgo * DAY, now, planId);
}

const env = (db: MemDb) => testEnv(db) as unknown as Env;

test("§PLAN-LATE: the app worries about a plan only after its date passed", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  try {
    await t.test("due two days ago → silence, the charge may still post", async () => {
      const db = migratedDb();
      seed(db);
      const id = plan(db, "Квартира", 2, now);
      charge(db, "old-rent", id, 33, now);              // last month's, so the plan has history
      assert.deepEqual(await draftMissedPlans(env(db), now), []);
    });

    await t.test("due four days ago with nothing linked → exactly one card, naming the date", async () => {
      const db = migratedDb();
      seed(db);
      const id = plan(db, "Квартира", 4, now);
      charge(db, "old-rent", id, 35, now);
      const out = await draftMissedPlans(env(db), now);
      assert.equal(out.length, 1);
      assert.equal(out[0].kind, "plan_missed");
      assert.equal(out[0].tparams?.days, 4);
      assert.equal(out[0].entity_id, String(id));
      // Keyed by the EXPECTED date, not by today: the charge is still missing tomorrow, and the
      // feed must not repeat the card every morning until it appears.
      assert.match(String(out[0].dedup_key), /^plan_missed:\d+:\d{4}-\d{2}-\d{2}$/);
    });

    await t.test("paid but never LINKED → silence, and the charge is linked on the way", async () => {
      // 2026-09-21, verbatim shape: Київстар paid on the 2nd for a plan due on the 4th, 251 ₴
      // against 250 ₴, the row stored without `planned_id` because a learned alias answered first.
      const db = migratedDb();
      seed(db);
      const id = plan(db, "Київстар", 4, now);
      charge(db, "aug", id, 35, now);
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, created_at, merchant)
         VALUES ('sep', 'acc-uah', 'mono', ?, -12510_00, 980, ?, 'Київстар')`,
      ).run(now - 6 * DAY, now);
      assert.deepEqual(await draftMissedPlans(env(db), now), []);
      const row = db.raw.prepare("SELECT planned_id FROM transactions WHERE id = 'sep'").get() as { planned_id: number };
      assert.equal(row.planned_id, id);
    });

    await t.test("the charge is there, two days early → silence", async () => {
      const db = migratedDb();
      seed(db);
      const id = plan(db, "Квартира", 4, now);
      charge(db, "rent", id, 6, now);                   // two days BEFORE the due date
      assert.deepEqual(await draftMissedPlans(env(db), now), []);
    });

    await t.test("a weekly plan: last cycle's late charge does not cover this cycle", async () => {
      const db = migratedDb();
      seed(db);
      // Weekly plan due 4 days ago; the previous due date was 11 days ago and its charge landed
      // 3 days late — inside LATE_GRACE_DAYS, so it was never reported. A flat 5-day early
      // tolerance would read that charge (8 days ago = due-4d) as THIS cycle's payment and stay
      // silent about a weekly plan that actually stopped.
      db.raw.prepare(
        `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active,
           currency_code, period_count) VALUES ('Мийка авто', 'subscription', 500_00, 'week', ?, 1, ?, 1)`,
      ).run(now - 4 * DAY - 52 * 7 * DAY, UAH);
      const wid = (db.raw.prepare("SELECT id FROM planned_payments WHERE title = 'Мийка авто'")
        .get() as { id: number }).id;
      charge(db, "clean-late", wid, 8, now);
      const out = await draftMissedPlans(env(db), now);
      assert.equal(out.length, 1, "the missed weekly cycle is reported");
      assert.equal(out[0].entity_id, String(wid));
    });

    await t.test("a plan that never charged at all is dead_sub's story, not this one", async () => {
      const db = migratedDb();
      seed(db);
      plan(db, "Квартира", 4, now);                     // no linked transaction ever
      assert.deepEqual(await draftMissedPlans(env(db), now), []);
    });
  } finally { restore(); }
});

test("lastDueUnix: the most recent scheduled date at or before now", () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  try {
    // A plan that started a year ago charges monthly; the last date must be within one month back.
    const start = now - 400 * DAY;
    const due = lastDueUnix(start, "month", 1, now)!;
    assert.ok(due <= now, "the last due date is not in the future");
    assert.ok(now - due < 32 * DAY, "and it is the MOST RECENT one, not an old one");
    // A plan whose first charge is still ahead has no past date at all.
    assert.equal(lastDueUnix(now + 5 * DAY, "month", 1, now), null);
  } finally { restore(); }
});

test("the AI feed may not call a not-yet-due charge missing", () => {
  const ahead = ["Квартира", "Spotify"];
  // The card verbatim.
  assert.equal(
    claimsMissingFutureCharge("Квартира відсутня в цьому місяці — у рахунках цього платежу немає", ahead),
    true,
  );
  assert.equal(claimsMissingFutureCharge("Spotify payment is missing this month", ahead), true);
  // An observation ABOUT the same plan that claims no absence stays.
  assert.equal(claimsMissingFutureCharge("Квартира — найбільша стаття цього місяця", ahead), false);
  // An absence claim about something that is NOT a scheduled charge stays: that is someone else's
  // guard, and over-rejecting here would silence half the feed.
  assert.equal(claimsMissingFutureCharge("доходу цього місяця ще немає", ahead), false);
});

test("§DIGEST-HOUR: one digest a day, at or after the chosen hour", () => {
  // 2026-05-14T09:00Z is 12:00 in Kyiv (§APP_TZ) — the whole point of the setting is that the
  // comparison happens in the reader's calendar, not in UTC.
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  try {
    assert.equal(digestDue(now, 20, null), false, "20:00 has not arrived yet");
    assert.equal(digestDue(now, 9, null), true, "09:00 is behind us and today has not spoken");
    assert.equal(digestDue(now, 9, "2026-05-14"), false, "today already spoke");
    assert.equal(digestDue(now, 9, "2026-05-13"), true, "yesterday's marker does not count");
    // A missed tick must not cost the whole day: at 12:00 an 11:00 digest still fires.
    assert.equal(digestDue(now, 11, null), true);
  } finally { restore(); }
  assert.equal(clampHour(25), 23);
  assert.equal(clampHour(-1), 0);
  assert.equal(clampHour("noon"), 20);
});

test("§DIGEST-HOUR: the infrastructure pass is once a UTC day, at or after its hour", async () => {
  // The hourly trigger turned this into a real failure mode: with `getUTCHours() === 6` a tick
  // delivered at 07:0x skipped the day's rates snapshot and backup outright, and the net-worth
  // series is only ever written forward — a hole in it never fills.
  const dir = migratedDirectoryDb();
  const env = { DIRECTORY: dir } as unknown as Parameters<typeof infraDue>[0];
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  assert.equal(await infraDue(env, at("2026-05-14T05:00:00Z"), 6), false, "before the hour");
  assert.equal(await infraDue(env, at("2026-05-14T06:00:00Z"), 6), true, "on the hour");
  // A tick that arrives an hour late still runs the day's pass.
  assert.equal(await infraDue(env, at("2026-05-14T07:00:00Z"), 6), true, "late but the same day");

  await markInfraRan(env, at("2026-05-14T07:00:00Z"));
  assert.equal(await infraDue(env, at("2026-05-14T08:00:00Z"), 6), false, "already ran today");
  assert.equal(await infraDue(env, at("2026-05-15T06:00:00Z"), 6), true, "a new UTC day");
});
