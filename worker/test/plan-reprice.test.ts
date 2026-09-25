/**
 * §PLAN-REPRICE and §PLAN-STATE — a subscription whose price changed is still that subscription,
 * and a plan knows what happened to its latest cycle.
 *
 * The case is the owner's, verbatim in shape (2026-09-24): YouTube Premium was 100 ₴ for months,
 * then 179 ₴ landed on the usual day under the usual name. `amountMatches` (±10%) refused it, so:
 *   · the charge was never linked to the plan;
 *   · the price rise was never announced — `draftPriceUps` reads LINKED charges only;
 *   · the subscription card promised next month's date for a plan whose current charge it had
 *     missed, instead of saying that something had happened to it.
 *
 * The first test below is the one that fails on the code before this change: the same call
 * without a time (which is all the matcher used to know) still answers «no plan».
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import {
  matchActiveSubscription, linkPlanHistoryById, nextChargeUnix,
} from "../lib/finance/subscriptions.ts";
import { planState, fitsNextCycle, repriceAmountPlausible, type LinkedCharge } from "../lib/finance/plan-state.ts";

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

const plannedIdOf = (db: MemDb, id: string) =>
  (db.raw.prepare("SELECT planned_id FROM transactions WHERE id = ?").get(id) as { planned_id: number | null }).planned_id;

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

    await t.test("the healing pass finds it in history, and never touches the declared price", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      history(db, id, now);
      tx(db, "yt-new", due + 3600, 179_00, "YouTube", null);
      await linkPlanHistoryById(db, id);
      assert.equal(plannedIdOf(db, "yt-new"), id);
      const pa = (db.raw.prepare("SELECT period_amount FROM planned_payments WHERE id = ?").get(id) as { period_amount: number }).period_amount;
      assert.equal(pa, 100_00, "a near-match must never silently rewrite money");
    });

    await t.test("three months at the new price link as a chain, each anchored on the one before", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      const ds = dues(now);
      ds.slice(-10, -3).forEach((d, i) => tx(db, `old-${i}`, d + 3600, 100_00, "YouTube", id));
      ds.slice(-3).forEach((d, i) => tx(db, `new-${i}`, d + 3600, 179_00, "YouTube", null));
      await linkPlanHistoryById(db, id);
      for (let i = 0; i < 3; i++) assert.equal(plannedIdOf(db, `new-${i}`), id, `new-${i}`);
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

    await t.test("a plan with no linked history has nothing to anchor on", async () => {
      const db = migratedDb(); seed(db);
      plan(db);
      const m = await matchActiveSubscription(db, {
        merchant: "YouTube", description: "YouTube", amount: -179_00, currency_code: UAH,
        time: due + 3600, id: "first",
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

    await t.test("another currency is another story", async () => {
      const db = migratedDb(); seed(db);
      const id = plan(db);
      history(db, id, now);
      const m = await matchActiveSubscription(db, {
        merchant: "YouTube", description: "YouTube", amount: -179_00, currency_code: 840,
        time: due + 3600, id: "usd",
      });
      assert.equal(m, null);
    });
  } finally { restore(); }
});

test("fitsNextCycle / repriceAmountPlausible — the two gates, at their edges", () => {
  const t0 = 1_700_000_000;
  assert.equal(fitsNextCycle(t0, t0 + 31 * DAY, "month", 1), true);
  assert.equal(fitsNextCycle(t0, t0 + 28 * DAY, "month", 1), true, "February");
  assert.equal(fitsNextCycle(t0, t0 + 61 * DAY, "month", 1), true, "one unlinked month in between");
  assert.equal(fitsNextCycle(t0, t0 + 15 * DAY, "month", 1), false, "mid-cycle");
  assert.equal(fitsNextCycle(t0, t0 + 7 * DAY, "week", 1), true);
  assert.equal(fitsNextCycle(t0, t0 + 3 * DAY, "week", 1), false);
  assert.equal(fitsNextCycle(t0, t0 - DAY, "month", 1), false, "never backwards");
  assert.equal(repriceAmountPlausible(179_00, 100_00), true);
  assert.equal(repriceAmountPlausible(300_00, 100_00), true);
  assert.equal(repriceAmountPlausible(301_00, 100_00), false);
  assert.equal(repriceAmountPlausible(1_00, 100_00), false, "trial → paid is a different story");
});

test("§PLAN-STATE: a plan says what happened to its latest cycle", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  const ds = dues(now);
  const due = ds.at(-1)!;
  const p = { start_date: START, period: "month", period_count: 1, period_amount: 100_00, currency_code: UAH, is_active: 1, end_date: null };
  const at = (d: number, amount = 100_00): LinkedCharge => ({ time: d + 3600, amount, currency_code: UAH });
  const past = ds.slice(0, -1).map((d) => at(d));
  try {
    await t.test("paid at the declared price", () => {
      const s = planState(p, [...past, at(due)], now);
      assert.equal(s.kind, "paid");
      assert.equal(s.paid_amount, 100_00);
    });

    await t.test("paid at a different price → changed, carrying the new amount", () => {
      const s = planState(p, [...past, at(due, 179_00)], now);
      assert.equal(s.kind, "changed");
      assert.equal(s.paid_amount, 179_00);
    });

    await t.test("one day past the date with nothing → due, the grace is not over", () => {
      assert.equal(planState(p, past, now).kind, "due");
    });

    await t.test("four days past → late, naming the date it was expected", () => {
      const s = planState(p, past, due + 4 * DAY);
      assert.equal(s.kind, "late");
      assert.equal(s.due_at, due);
      assert.equal(s.late_days, 4);
      assert.equal(s.missed_cycles, 1);
    });

    await t.test("two cycles with nothing → missing; three → stopped", () => {
      assert.equal(planState(p, past.slice(0, -1), due + 4 * DAY).kind, "missing");
      assert.equal(planState(p, past.slice(0, -2), due + 4 * DAY).kind, "stopped");
    });

    await t.test("cycles before the FIRST linked charge are not missed — the ledger may not reach them", () => {
      // Only the last two cycles are in the ledger; the plan is a year old.
      const s = planState(p, [at(ds.at(-3)!), at(ds.at(-2)!)], now);
      assert.equal(s.kind, "due");
      assert.equal(s.missed_cycles, 0);
    });

    await t.test("ended and no_history are their own answers", () => {
      assert.equal(planState({ ...p, is_active: 0 }, past, now).kind, "ended");
      assert.equal(planState({ ...p, end_date: now - DAY }, past, now).kind, "ended");
      assert.equal(planState(p, [], now).kind, "no_history");
    });

    await t.test("a charge a couple of days EARLY settles the cycle (§PLAN-LATE's tolerance)", () => {
      assert.equal(planState(p, [...past, at(due - 2 * DAY)], due + 4 * DAY).kind, "paid");
    });
  } finally { restore(); }
});
