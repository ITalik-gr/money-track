/**
 * §PLAN-LINK — a plan finds the charges it already has.
 *
 * The defect this pins was the one that made the whole subscriptions feature read as broken:
 * `transactions.planned_id` was written at INGEST and inside a Settings button, and nowhere else.
 * `POST /planned` created the row and stopped. So a plan declared today — which is WHEN people
 * declare them, after paying for months — opened with zero charges, and the page, the feed and
 * `plannedActuals` all agreed that a subscription paid every month had never been charged.
 *
 * The three policies below are each a decision that could have gone the other way, and two of
 * them protect work already done — the same rule as §RULES-UI apply and §SIMILAR.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
const DAY = 86400;

/** One charge, with everything the matcher reads. */
function charge(
  db: MemDb, id: string, o: { merchant?: string | null; amount: number; daysAgo: number;
    category?: number | null; planned?: number | null; note?: string | null; desc?: string | null },
): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
       category_id, planned_id, ai_note, raw_json, created_at)
     VALUES (?, 'acc-uah', 'mono', ?, ?, 980, ?, ?, ?, ?, ?, ?)`,
  ).run(id, NOW - o.daysAgo * DAY, o.amount, o.merchant ?? null, o.category ?? null,
    o.planned ?? null, o.note ?? null,
    o.desc == null ? null : JSON.stringify({ description: o.desc }), NOW);
}

async function createPlan(db: MemDb, body: Record<string, unknown>): Promise<{ id: number; linked: number }> {
  const res = await api.request("/planned", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "subscription", period: "month", period_count: 1,
      currency_code: 980, start_date: NOW - 90 * DAY, ...body }),
  }, testEnv(db) as never);
  assert.equal(res.status, 200);
  return await res.json() as { id: number; linked: number };
}

const linkedIds = (db: MemDb, planId: number): string[] =>
  (db.raw.prepare("SELECT id FROM transactions WHERE planned_id = ? ORDER BY id").all(planId) as { id: string }[])
    .map((r) => r.id);

const categoryOf = (db: MemDb, id: string): number | null =>
  (db.raw.prepare("SELECT category_id AS c FROM transactions WHERE id = ?").get(id) as { c: number | null }).c;

test("§PLAN-LINK: declaring a plan attaches the charges it ALREADY has", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("a new plan links its history, and does not touch charges of a different size", async () => {
      const db = migratedDb();
      seed(db);
      charge(db, "sp-1", { merchant: "Spotify", amount: -22_200, daysAgo: 5 });
      charge(db, "sp-2", { merchant: "Spotify", amount: -22_500, daysAgo: 35 });   // within ±10%
      charge(db, "sp-3", { merchant: "Spotify", amount: -22_000, daysAgo: 65 });
      // A one-off family plan upgrade at three times the price is NOT this subscription's charge.
      charge(db, "sp-big", { merchant: "Spotify", amount: -66_600, daysAgo: 20 });

      const { id, linked } = await createPlan(db, { title: "Spotify", period_amount: 22_200 });
      assert.equal(linked, 3);
      assert.deepEqual(linkedIds(db, id), ["sp-1", "sp-2", "sp-3"]);
    });

    await t.test("a plan with NO category still links — the two are different questions", async () => {
      // The manual add form does not ask for a category at all, and `activeSubs` used to require
      // one. So every hand-added plan matched nothing, ever, not even on ingest.
      const db = migratedDb();
      seed(db);
      charge(db, "yt-1", { merchant: "YouTube Premium", amount: -9_900, daysAgo: 4 });
      charge(db, "yt-2", { merchant: "YouTube Premium", amount: -9_900, daysAgo: 34 });

      const { id, linked } = await createPlan(db, { title: "YouTube Premium", period_amount: 9_900 });
      assert.equal(linked, 2);
      assert.deepEqual(linkedIds(db, id), ["yt-1", "yt-2"]);
      // …and it filed nothing, because it had nothing to file them under.
      assert.equal(categoryOf(db, "yt-1"), null);
    });

    await t.test("an existing category is NEVER overwritten; an empty one is filled", async () => {
      // A stored category is a decision — the bank's MCC, a learned alias, the AI, or the person.
      // A plan only says "this is the same charge"; overwriting would be the app arguing silently
      // with work already done.
      const db = migratedDb();
      seed(db);
      charge(db, "cl-filed", { merchant: "Claude", amount: -107_000, daysAgo: 3, category: 6 });
      charge(db, "cl-empty", { merchant: "Claude", amount: -107_400, daysAgo: 33 });

      const { id } = await createPlan(db, { title: "Claude", period_amount: 107_000, category_id: 2 });
      assert.deepEqual(linkedIds(db, id), ["cl-empty", "cl-filed"]);
      assert.equal(categoryOf(db, "cl-filed"), 6, "the existing decision stands");
      assert.equal(categoryOf(db, "cl-empty"), 2, "the gap is filled");
    });

    await t.test("a charge already claimed by ANOTHER plan is not re-pointed", async () => {
      // It was matched by that plan's own name and amount. Moving it would let two screens
      // disagree about which subscription a charge belongs to.
      const db = migratedDb();
      seed(db);
      const first = await createPlan(db, { title: "Apple", period_amount: 4_400 });
      charge(db, "ap-1", { merchant: "Apple Music", amount: -4_400, daysAgo: 6, planned: first.id });

      const second = await createPlan(db, { title: "Apple", period_amount: 4_400 });
      assert.equal(second.linked, 0);
      assert.deepEqual(linkedIds(db, first.id), ["ap-1"]);
      assert.deepEqual(linkedIds(db, second.id), []);
    });

    await t.test("§SUB-ALIAS: adding the note LINKS — the plan's other names count", async () => {
      // The owner's actual case: the charge is «X Corp.», the plan is «Twitter». Editing the note
      // to say so and seeing nothing happen is the same dead end the create route had — which is
      // why PATCH re-runs the link, not just POST.
      const db = migratedDb();
      seed(db);
      charge(db, "x-1", { merchant: "X Corp.", amount: -11_600, daysAgo: 2 });
      charge(db, "x-2", { merchant: "X Corp.", amount: -11_500, daysAgo: 32 });

      const { id, linked } = await createPlan(db, { title: "Twitter", period_amount: 11_600 });
      assert.equal(linked, 0, "nothing matches the title alone");

      const res = await api.request(`/planned/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "списується як Corp, це твітер" }),
      }, testEnv(db) as never);
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { linked: number }).linked, 2);
      assert.deepEqual(linkedIds(db, id), ["x-1", "x-2"]);
    });

    await t.test("the AI's own note about a charge is searched too", async () => {
      // The model wrote down what the user explained on the transaction. Not reading it back is
      // the app forgetting an answer it was given (§SUB-FIND, same haystack).
      const db = migratedDb();
      seed(db);
      charge(db, "note-1", { merchant: "PADDLE.NET", amount: -22_400, daysAgo: 7, note: "Cloudflare Workers підписка" });
      charge(db, "note-2", { merchant: "PADDLE.NET", amount: -22_400, daysAgo: 37, note: "Cloudflare Workers підписка" });

      const { id, linked } = await createPlan(db, { title: "Cloudflare", period_amount: 22_400 });
      assert.equal(linked, 2);
      assert.deepEqual(linkedIds(db, id), ["note-1", "note-2"]);
    });

    await t.test("an INCOME plan links nothing — there is no outflow to claim", async () => {
      const db = migratedDb();
      seed(db);
      charge(db, "sal-1", { merchant: "Зарплата", amount: -4_500_000, daysAgo: 10 });
      const res = await api.request("/planned", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Зарплата", kind: "income", period: "month", period_count: 1,
          currency_code: 980, start_date: NOW - 90 * DAY, period_amount: 4_500_000 }),
      }, testEnv(db) as never);
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { linked: number }).linked, 0);
    });
  } finally { restore(); }
});
