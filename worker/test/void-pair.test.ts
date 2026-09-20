/**
 * §VOID-PAIR — «Bolt −181» and «Скасування. Bolt +181» are one event in the feed.
 *
 * Pinned against the real schema and the real feed query, because the pairing is SQL: what has to
 * hold is one-to-one matching (a single cancellation never swallows two purchases) and the
 * refusals (a partial refund, another account, a transfer, a month later).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";
import { listFeed } from "../repo/transactions.ts";
import type { AppDb } from "../lib/platform/db-shim.ts";

const T0 = Date.UTC(2026, 8, 14, 9) / 1000;

function db(): MemDb {
  const m = migratedDb();
  seed(m);
  for (const t of ["tx_splits", "tx_reimbursements", "ai_changes", "transactions"]) m.raw.prepare(`DELETE FROM ${t}`).run();
  return m;
}

function tx(m: MemDb, id: string, at: number, amount: number, merchant: string, o: { acc?: string; mcc?: number; transfer?: number } = {}) {
  m.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, mcc,
       category_id, hold, is_transfer, created_at)
     VALUES (?, ?, 'manual', ?, ?, 980, ?, ?, NULL, 0, ?, 0)`,
  ).run(id, o.acc ?? "acc-uah", at, amount, merchant, o.mcc ?? null, o.transfer ?? 0);
}

async function feed(m: MemDb) {
  const rows = await listFeed(m as unknown as AppDb, "uk", { limit: 50, offset: 0 });
  return Object.fromEntries(rows.map((r) => [r.id, { voided_by: r.voided_by ?? null, voids: r.voids ?? null }]));
}

test("a cancellation pairs with its purchase, both ways", async () => {
  const m = db();
  tx(m, "buy", T0, -18100, "Bolt");
  tx(m, "cancel", T0 + 180, 18100, "Скасування. Bolt");
  const f = await feed(m);
  assert.deepEqual(f.buy, { voided_by: "cancel", voids: null });
  assert.deepEqual(f.cancel, { voided_by: null, voids: "buy" });
});

test("buy, buy, cancel: only the later purchase is cancelled", async () => {
  const m = db();
  tx(m, "b1", T0, -18100, "Bolt");
  tx(m, "b2", T0 + 60, -18100, "Bolt");
  tx(m, "c", T0 + 120, 18100, "Скасування. Bolt");
  const f = await feed(m);
  assert.equal(f.b1!.voided_by, null);
  assert.equal(f.b2!.voided_by, "c");
  assert.equal(f.c!.voids, "b2");
});

test("buy, cancel, buy, cancel: two pairs, not one", async () => {
  const m = db();
  tx(m, "b1", T0, -18100, "Bolt");
  tx(m, "c1", T0 + 60, 18100, "Скасування. Bolt");
  tx(m, "b2", T0 + 120, -18100, "Bolt");
  tx(m, "c2", T0 + 180, 18100, "Скасування. Bolt");
  const f = await feed(m);
  assert.equal(f.b1!.voided_by, "c1");
  assert.equal(f.b2!.voided_by, "c2");
  assert.equal(f.c1!.voids, "b1");
  assert.equal(f.c2!.voids, "b2");
});

test("a renamed purchase still pairs through the shared MCC", async () => {
  const m = db();
  tx(m, "buy", T0, -18100, "Таксі Bolt", { mcc: 4121 });
  tx(m, "cancel", T0 + 60, 18100, "Скасування. BOLT.EU", { mcc: 4121 });
  assert.equal((await feed(m)).buy!.voided_by, "cancel");
});

test("not a cancellation: partial refund, other account, transfer, too late, no prefix", async () => {
  const m = db();
  tx(m, "p1", T0, -18100, "Bolt");
  tx(m, "r1", T0 + 60, 9000, "Скасування. Bolt");                               // partial
  tx(m, "p2", T0, -20000, "Uklon");
  tx(m, "r2", T0 + 60, 20000, "Скасування. Uklon", { acc: "acc-cred" });          // other account
  tx(m, "p3", T0, -30000, "Glovo");
  tx(m, "r3", T0 + 40 * 86400, 30000, "Скасування. Glovo");                    // 40 days later
  tx(m, "p4", T0, -40000, "Rozetka", { transfer: 1 });
  tx(m, "r4", T0 + 60, 40000, "Скасування. Rozetka");                          // transfer leg
  tx(m, "p5", T0, -50000, "Іван");
  tx(m, "r5", T0 + 60, 50000, "Іван");                                          // a friend paying back
  const f = await feed(m);
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) assert.equal(f[id]!.voided_by, null, id);
  for (const id of ["r1", "r2", "r3", "r4", "r5"]) assert.equal(f[id]!.voids, null, id);
});

/**
 * The feed's cards are claims about money the person LOST. A charge the bank already cancelled is
 * money that came back, so «велика витрата» about it is a false alarm — and «списано двічі» about
 * a double charge whose second leg was reversed sends the person to the bank over nothing.
 */
test("a cancelled charge produces no card about itself", async () => {
  const { draftBigTx, draftDuplicates } = await import("../lib/messaging/drafts-tx.ts");
  const m = db();
  const env = { DB: m } as unknown as Parameters<typeof draftBigTx>[0];
  const now = T0 + 3600;
  // A category with an ordinary history, so the big-spend branch has an average to compare to.
  for (let i = 0; i < 6; i++) {
    m.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
         category_id, hold, is_transfer, created_at)
       VALUES (?, 'acc-uah', 'manual', ?, -20000, 980, ?, 2, 0, 0, 0)`,
    ).run(`h${i}`, now - (10 + i * 5) * 86400, `Кафе ${i}`);
  }
  const big = (id: string, at: number) => m.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
       category_id, hold, is_transfer, created_at)
     VALUES (?, 'acc-uah', 'manual', ?, -300000, 980, 'Ресторан', 2, 0, 0, 0)`,
  ).run(id, at);

  big("big", now - 3600);
  assert.equal((await draftBigTx(env, now)).length, 1, "an uncancelled big charge IS news");

  tx(m, "big-cancel", now - 1800, 300000, "Скасування. Ресторан");
  assert.deepEqual(await draftBigTx(env, now), [], "once cancelled it is not");

  // The same for a double charge: two identical debits, one of them reversed.
  big("dup2", now - 3000);
  assert.deepEqual(await draftDuplicates(env, now), [],
    "the surviving charge has no uncancelled twin");
});
