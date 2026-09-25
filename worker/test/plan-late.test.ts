/**
 * §PLAN-LATE — a scheduled payment is news only 3 days AFTER its date, and «not linked» is not «not
 * paid». §DIGEST-HOUR — one digest a day, at or after the chosen hour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { draftMissedPlans } from "../lib/messaging/drafts-plans.ts";
import { claimsMissingFutureCharge } from "../lib/ai/grounding.ts";
import { digestDue, clampHour } from "../lib/messaging/digest.ts";
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
