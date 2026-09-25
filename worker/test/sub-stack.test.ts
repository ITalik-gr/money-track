/**
 * §SUB-STACK — the subscriptions as one thing: the total, what was really paid, two-of-a-kind, and
 * trials that turned into full charges.
 *
 * The first test is the reconciliation that matters most: the stack card sits under the
 * Subscriptions page hero, and the two «per month» figures must be one number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import { detectTrial, stackDrift } from "../lib/finance/sub-stack.ts";
import type { SubStack, PlannedRow, SubscriptionOverview } from "../../shared/api/planning.ts";

async function get<T>(db: MemDb, path: string): Promise<T> {
  const res = await api.request(path, { method: "GET" }, testEnv(db));
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return await res.json() as T;
}

const DAY = 86400;

test("§SUB-STACK: the stack's monthly IS the page hero's — Σ monthly_base over outflow plans", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb(); seed(db);
    const [stack, rows] = await Promise.all([
      get<SubStack>(db, "/planned/stack"),
      get<PlannedRow[]>(db, "/planned"),
    ]);
    const outflow = rows.filter((p) => p.kind !== "income");
    assert.equal(stack.monthly, outflow.reduce((s, p) => s + p.monthly_base, 0));
    assert.equal(stack.count, outflow.length);
    assert.deepEqual(stack.paid.map((p) => p.ym), [...stack.paid.map((p) => p.ym)].sort(), "oldest first");
  } finally { restore(); }
});

test("detectTrial: a 1 ₴ check then full charges is a trial; a steady price is not", () => {
  const t0 = 1_760_000_000;
  const tr = detectTrial([
    { time: t0, amount: 1_00, currency_code: 980 },
    { time: t0 + 30 * DAY, amount: 179_00, currency_code: 980 },
    { time: t0 + 60 * DAY, amount: 179_00, currency_code: 980 },
  ]);
  assert.deepEqual(tr, { trial_amount: 1_00, trial_at: t0, paid_amount: 179_00, paid_since: t0 + 30 * DAY });
  assert.equal(detectTrial([
    { time: t0, amount: 179_00, currency_code: 980 },
    { time: t0 + 30 * DAY, amount: 179_00, currency_code: 980 },
  ]), null);
  // A PRICE RISE is not a trial: 100 → 179 is §PLAN-REPRICE's story.
  assert.equal(detectTrial([
    { time: t0, amount: 100_00, currency_code: 980 },
    { time: t0 + 30 * DAY, amount: 179_00, currency_code: 980 },
  ]), null);
  // One charge proves nothing; a first charge in another currency is not compared.
  assert.equal(detectTrial([{ time: t0, amount: 1_00, currency_code: 980 }]), null);
  assert.equal(detectTrial([
    { time: t0, amount: 1_00, currency_code: 840 },
    { time: t0 + 30 * DAY, amount: 179_00, currency_code: 980 },
  ]), null);
});

test("stackDrift: first three months against the last three, and silent without six", () => {
  const s = (vals: number[]) => vals.map((paid, i) => ({ ym: `2026-${String(i + 1).padStart(2, "0")}`, paid }));
  assert.deepEqual(stackDrift(s([100, 100, 100, 130, 130, 130])), { from_avg: 100, to_avg: 130, pct: 30 });
  assert.equal(stackDrift(s([100, 100, 100, 130, 130])), null);
  assert.equal(stackDrift(s([0, 0, 0, 130, 130, 130])), null, "nothing at the start is not a +∞% rise");
});

test("§SUB-STACK: two live subscriptions under one leaf category are asked about; one is not", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb(); seed(db);
    const now = Math.floor(Date.now() / 1000);
    const cat = (db.raw.prepare("SELECT id FROM categories WHERE parent_id IS NOT NULL LIMIT 1").get() as { id: number }).id;
    const add = (title: string, amount: number) => db.raw.prepare(
      `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active, currency_code, period_count, category_id)
       VALUES (?, 'subscription', ?, 'month', ?, 1, 980, 1, ?)`,
    ).run(title, amount, now - 90 * DAY, cat);
    add("Netflix", 299_00);
    add("Megogo", 199_00);
    const stack = await get<SubStack>(db, "/planned/stack");
    const d = stack.duplicates.find((x) => x.category_id === cat);
    assert.ok(d, "the pair is surfaced");
    assert.deepEqual(d!.plans.map((p) => p.title), ["Netflix", "Megogo"], "dearest first");
  } finally { restore(); }
});

test("§SUB-STACK: a subscription page says what cancelling frees, in money and in points of income", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb(); seed(db);
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active, currency_code, period_count)
       VALUES ('YouTube Premium', 'subscription', 179_00, 'month', ?, 1, 980, 1)`,
    ).run(now - 90 * DAY);
    const id = (db.raw.prepare("SELECT id FROM planned_payments WHERE title = 'YouTube Premium'").get() as { id: number }).id;
    const o = await get<SubscriptionOverview>(db, `/planned/${id}/overview`);
    assert.equal(o.cancel.monthly, o.plan.monthly_base);
    assert.equal(o.cancel.annual, o.plan.monthly_base * 12);
    assert.ok(o.cancel.income_share_pp != null && o.cancel.income_share_pp > 0, "the fixture has income");
  } finally { restore(); }
});

test("§SUB-SETTINGS: PATCH edits the schedule, and refuses one the schedule code cannot run", async () => {
  const db = migratedDb(); seed(db);
  db.raw.prepare(
    `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, is_active, currency_code, period_count)
     VALUES ('YouTube Premium', 'subscription', 100_00, 'month', 1760000000, 1, 980, 1)`,
  ).run();
  const id = (db.raw.prepare("SELECT id FROM planned_payments WHERE title = 'YouTube Premium'").get() as { id: number }).id;
  const patch = (body: unknown) => api.request(`/planned/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, testEnv(db));
  for (const bad of [{ period_amount: 0 }, { period_amount: 99.5 }, { period: "year" }, { period_count: 0 }, { period_count: 25 }]) {
    assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await patch({ period_amount: 179_00, period: "month", period_count: 1 })).status, 200);
  const row = db.raw.prepare("SELECT period_amount, period, period_count FROM planned_payments WHERE id = ?").get(id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { period_amount: 179_00, period: "month", period_count: 1 });
});
