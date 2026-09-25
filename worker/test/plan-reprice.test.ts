/**
 * §PLAN-REPRICE — a new price on the usual day under the usual name is still the same subscription
 * (YouTube 100 → 179 ₴). §PLAN-STATE — a plan says what happened to its latest cycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import {
  matchActiveSubscription, nextChargeUnix,
} from "../lib/finance/subscriptions.ts";

const DAY = 86400;
const UAH = 980;
// The 13th, at noon Kyiv: one day before the frozen «now» (2026-05-14 12:00 Kyiv), so the latest
// cycle is due and still inside §PLAN-LATE's grace.
const START = Math.floor(Date.UTC(2025, 4, 13, 9, 0, 0) / 1000);

/** Every due date of a monthly plan from START up to `until`, from the ONE schedule. */
function dues(until: number): number[] {
  const out: number[] = [];
  let t = START;
  for (let g = 0; g < 40 && t <= until; g++) {
    out.push(t);
    t = nextChargeUnix(START, "month", 1, t);
  }
  return out;
}

function plan(db: MemDb, title = "YouTube Premium", amount = 100_00): number {
  db.raw.prepare(
    `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active,
       currency_code, period_count) VALUES (?, 'subscription', ?, 'month', ?, 1, ?, 1)`,
  ).run(title, amount, START, UAH);
  return (db.raw.prepare("SELECT id FROM planned_payments WHERE title = ?").get(title) as { id: number }).id;
}

function tx(db: MemDb, id: string, time: number, amount: number, merchant: string, planId: number | null): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, created_at, merchant, planned_id)
     VALUES (?, 'acc-uah', 'mono', ?, ?, ?, ?, ?, ?)`,
  ).run(id, time, -amount, UAH, time, merchant, planId);
}


/** Nine months at 100 ₴, every one linked — an established series. */
function history(db: MemDb, planId: number, now: number, months = 9): number[] {
  const ds = dues(now).slice(0, -1).slice(-months);
  ds.forEach((d, i) => tx(db, `yt-${i}`, d + 3600, 100_00, "YouTube", planId));
  return ds;
}

test("§PLAN-REPRICE: the owner's YouTube — 100 → 179 ₴ on the usual day is still YouTube", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  const due = dues(now).at(-1)!;
  try {
    await t.test("the ingest-time match links it, flagged as a reprice", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      history(db, id, now);
      const input = { merchant: "YouTube", description: "YouTube Premium", amount: -179_00, currency_code: UAH };
      // What the matcher could say before: no time, no cycle, so the ±10% gate is all there is.
      assert.equal(await matchActiveSubscription(db, input), null);
      const m = await matchActiveSubscription(db, { ...input, time: due + 3600, id: "yt-new" });
      assert.equal(m?.planned_id, id);
      assert.equal(m?.repriced, true);
    });

  } finally { restore(); }
});

test("§PLAN-REPRICE: what the amount gate protected against is still refused", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  const due = dues(now).at(-1)!;
  try {
    await t.test("a purchase from the same brand in the MIDDLE of a cycle", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      history(db, id, now);
      const m = await matchActiveSubscription(db, {
        merchant: "YouTube", description: "YouTube movie rental", amount: -179_00, currency_code: UAH,
        time: due - 15 * DAY, id: "rental",
      });
      assert.equal(m, null);
    });

    await t.test("an amount far outside any real price change (×3)", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      history(db, id, now);
      const m = await matchActiveSubscription(db, {
        merchant: "YouTube", description: "YouTube", amount: -10_000_00, currency_code: UAH,
        time: due + 3600, id: "big",
      });
      assert.equal(m, null);
    });

    await t.test("a cycle already settled does not take a second charge", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      history(db, id, now);
      tx(db, "settled", due + 3600, 100_00, "YouTube", id);
      const m = await matchActiveSubscription(db, {
        merchant: "YouTube", description: "YouTube", amount: -179_00, currency_code: UAH,
        time: due + 2 * 3600, id: "second",
      });
      assert.equal(m, null);
    });

  } finally { restore(); }
});
