/**
 * §ENRICH-GATE — asking the model about what is unknown, and only that.
 *
 * The owner's case opens the file, and it is a bug made of two correct behaviours. An Apple
 * subscription charge arrived; an MCC rule filed it under «Сервіси, SaaS продукти», which is the
 * right category; the webhook's gate was `category_id IS NULL`, so enrichment never ran; and
 * `ai_recurring` — the only thing that draws the subscription icon and feeds §SUB-DETECT — is
 * written by enrichment alone. Every month the fix was the owner pressing «Розпізнати» himself.
 *
 * The other half is the reason the gate cannot simply become «always ask»: the owner named the
 * classes that must stay free («продуктів, між картками, округлення балансу… бо там і так все
 * зрозуміло»). So most scenarios below are about a REFUSAL to spend, and each one fails silently
 * in its own direction — a wrongly-skipped charge is an icon that never appears, a wrongly-asked
 * one is a bill nobody sees until the month's total.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { enrichVerdict, gateRow, applyCarry } from "../lib/ai/enrich-gate.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import type { Env } from "../env.ts";

const NOW = Math.floor(Date.parse("2026-09-06T09:00:00Z") / 1000);
const DAY = 86_400;
/** Seeded ids: 13 «Перекази і зняття», 1 «Продукти». */
const TRANSFERS = 13, GROCERIES = 1;
/** Any ordinary expense category that is not one of the above — the SaaS bucket in the seed. */
const SERVICES = 9;

interface Seed {
  id: string; desc: string; merchant?: string | null; mcc?: number | null;
  category?: number | null; amount?: number; isTransfer?: number; pair?: string | null;
  enriched?: number; recurring?: number | null; daysAgo?: number;
}

function seedDb(rows: Seed[]): MemDb {
  const d = migratedDb();
  d.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('acc1', 'black', 'Картка', 980, 100000, 0, 1, 0)`,
  ).run();
  for (const s of rows) {
    d.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, mcc,
                                 category_id, is_transfer, transfer_pair_id, ai_enriched, ai_recurring, raw_json)
       VALUES (?, 'acc1', 'mono', ?, ?, 980, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id, NOW - (s.daysAgo ?? 0) * DAY, s.amount ?? -4435, s.merchant ?? s.desc, s.mcc ?? null,
      s.category ?? null, s.isTransfer ?? 0, s.pair ?? null, s.enriched ?? 0,
      s.recurring ?? null, JSON.stringify({ description: s.desc }),
    );
  }
  return d;
}

async function verdictFor(d: MemDb, id: string) {
  const env = testEnv(d) as unknown as Env;
  const row = await gateRow(env, id);
  assert.ok(row, "the row must exist for the gate to have anything to say");
  return await enrichVerdict(env, row!);
}

test("§ENRICH-GATE: what is worth asking a model about", async (t) => {
  await t.test("the owner's case: a categorised charge is still an unanswered question", async () => {
    // Exactly the screenshot — MCC 5734 (software), filed correctly by a rule, no verdict on
    // whether it repeats. The OLD gate (`category_id IS NULL`) returned "nothing to do" here.
    const d = seedDb([{ id: "t1", desc: "APPLE.COM/BILL", mcc: 5734, category: SERVICES }]);
    assert.deepEqual(await verdictFor(d, "t1"), { verdict: "ask" });
  });

  await t.test("an uncategorised charge is still asked about — the old gate is not weakened", async () => {
    const d = seedDb([{ id: "t1", desc: "SOMETHING NEW", mcc: 5999, category: null }]);
    assert.deepEqual(await verdictFor(d, "t1"), { verdict: "ask" });
  });

  await t.test("groceries are not a question: the MCC is already the whole answer", async () => {
    const d = seedDb([{ id: "t1", desc: "SILPO 234", mcc: 5411, category: GROCERIES, amount: -85000 }]);
    assert.equal((await verdictFor(d, "t1")).verdict, "skip");
  });

  await t.test("own money moving between own places is never asked about", async (st) => {
    await st.test("a paired card-to-card", async () => {
      const d = seedDb([{ id: "t1", desc: "З Білої картки", category: SERVICES, pair: "t2" }]);
      assert.equal((await verdictFor(d, "t1")).verdict, "skip");
    });
    await st.test("a balance round-up, whose second side may not even exist", async () => {
      // No pair, no `is_transfer` yet — recognised from the bank's own wording, the same rule
      // §F2's one-sided fallback uses. This is the class the owner named outright.
      const d = seedDb([{ id: "t1", desc: "Округлення балансу", category: SERVICES, amount: -65 }]);
      assert.equal((await verdictFor(d, "t1")).verdict, "skip");
    });
    await st.test("anything sitting in the transfers bucket", async () => {
      const d = seedDb([{ id: "t1", desc: "Зняття готівки", mcc: 6011, category: TRANSFERS }]);
      assert.equal((await verdictFor(d, "t1")).verdict, "skip");
    });
  });

  await t.test("the SECOND charge of a known merchant is copied, not re-bought", async () => {
    const d = seedDb([
      { id: "old", desc: "APPLE.COM/BILL", merchant: "Apple", mcc: 5734, category: SERVICES, enriched: 1, recurring: 1, daysAgo: 30 },
      { id: "new", desc: "APPLE.COM/BILL", merchant: "Apple", mcc: 5734, category: SERVICES },
    ]);
    const v = await verdictFor(d, "new");
    assert.deepEqual(v, { verdict: "carry", recurring: 1, merchant: "Apple" });

    await applyCarry(testEnv(d) as unknown as Env, "new", 1);
    const row = d.raw.prepare("SELECT ai_recurring, ai_enriched, merchant FROM transactions WHERE id = 'new'")
      .get() as { ai_recurring: number; ai_enriched: number; merchant: string };
    assert.equal(row.ai_recurring, 1, "the icon appears without a model call");
    assert.equal(row.ai_enriched, 0, "…and the row is honest that no model was asked about IT");
    assert.equal(row.merchant, "Apple", "carry writes the flag and nothing else");
  });

  await t.test("a merchant the gate itself skipped carries no verdict to hand on", async () => {
    // `ai_enriched = 0` with a `0` flag is what an untouched row looks like; treating that as a
    // considered "no" would let one skip propagate down the whole history of a merchant.
    const d = seedDb([
      { id: "old", desc: "NEW BILLER", mcc: 5734, category: SERVICES, enriched: 0, recurring: null, daysAgo: 30 },
      { id: "new", desc: "NEW BILLER", mcc: 5734, category: SERVICES },
    ]);
    assert.deepEqual(await verdictFor(d, "new"), { verdict: "ask" });
  });

  await t.test("a known merchant billed at an everyday MCC still carries its own verdict", async () => {
    // History is consulted BEFORE the MCC list on purpose: a café that sells a monthly pass is
    // filed at 5812, and the list would otherwise wave away the one charge that does repeat.
    const d = seedDb([
      { id: "old", desc: "CLUB MONTHLY", merchant: "Club", mcc: 5812, category: SERVICES, enriched: 1, recurring: 1, daysAgo: 30 },
      { id: "new", desc: "CLUB MONTHLY", merchant: "Club", mcc: 5812, category: SERVICES },
    ]);
    assert.deepEqual(await verdictFor(d, "new"), { verdict: "carry", recurring: 1, merchant: "Club" });
  });

  await t.test("income is out of scope — `ai_recurring` is about a charge", async () => {
    const d = seedDb([{ id: "t1", desc: "Зарплата", category: SERVICES, amount: 5_000_00 }]);
    assert.equal((await verdictFor(d, "t1")).verdict, "skip");
  });

  await t.test("a row already enriched is never re-asked", async () => {
    const d = seedDb([{ id: "t1", desc: "APPLE.COM/BILL", mcc: 5734, category: SERVICES, enriched: 1, recurring: 0 }]);
    assert.equal((await verdictFor(d, "t1")).verdict, "skip");
  });
});
