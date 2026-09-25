/**
 * §PLAN-LINK — declaring a plan attaches the charges it already has, without overwriting a category or
 * stealing another plan's charge; a known merchant is linked at ingest too.
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

  } finally { restore(); }
});

test("§PLAN-LINK: a KNOWN merchant's charge is still linked to its plan at ingest", async () => {
  // 2026-09-21: from the second month on, a plan's charge hits a learned alias first, and the alias
  // step returned `planned_id: null` — so «Київстар — платіж не пройшов» for a bill paid on time.
  // The raw text is Latin and the plan Cyrillic: only the alias's display name bridges them.
  const { categorize } = await import("../lib/finance/categorize.ts");
  const db = migratedDb();
  seed(db);
  db.raw.prepare(
    `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active, currency_code, period_count)
     VALUES ('Київстар', 'subscription', 25000, 'month', ?, 1, 980, 1)`,
  ).run(NOW - 90 * DAY);
  const planId = (db.raw.prepare("SELECT id FROM planned_payments WHERE title = 'Київстар'").get() as { id: number }).id;
  db.raw.prepare(
    `INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, is_transfer, source, created_at)
     VALUES ('mono_desc', 'KYIVSTAR', 'Київстар', 7, 0, 'ai', ?)`,
  ).run(NOW);
  const r = await categorize(db, { mcc: 4814, description: "KYIVSTAR", comment: null, amount: -25100, currency_code: 980 });
  assert.equal(r.source, "alias_desc", "the alias still decides the category");
  assert.equal(r.planned_id, planId);
});
