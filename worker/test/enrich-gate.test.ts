/**
 * §ENRICH-GATE — the webhook asks the model only about what is unknown (skip / carry / ask), and a
 * user note outranks every skip within its daily cap.
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
  enriched?: number; recurring?: number | null; daysAgo?: number; note?: string | null;
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
                                 category_id, is_transfer, transfer_pair_id, ai_enriched, ai_recurring,
                                 raw_json, user_note)
       VALUES (?, 'acc1', 'mono', ?, ?, 980, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id, NOW - (s.daysAgo ?? 0) * DAY, s.amount ?? -4435, s.merchant ?? s.desc, s.mcc ?? null,
      s.category ?? null, s.isTransfer ?? 0, s.pair ?? null, s.enriched ?? 0,
      s.recurring ?? null, JSON.stringify({ description: s.desc }), s.note ?? null,
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

  await t.test("a row already enriched is never re-asked", async () => {
    const d = seedDb([{ id: "t1", desc: "APPLE.COM/BILL", mcc: 5734, category: SERVICES, enriched: 1, recurring: 0 }]);
    assert.equal((await verdictFor(d, "t1")).verdict, "skip");
  });
});

/**
 * A USER NOTE overrides every skip — the defect §AI-EVAL found on 2026-09-18 and the cap that
 * made fixing it safe.
 */
test("§ENRICH-GATE: a note is a human sentence, and it outranks every skip", async (t) => {
  await t.test("a note on a transfers-bucket row is asked about, not filed silently", async () => {
    // The pinned-red eval case, as a unit test: MCC 4829 files it in the transfers bucket, so the
    // gate used to stop there and the model never saw «I moved my own salary out of crypto».
    const d = seedDb([{
      id: "t1", desc: "Від Ihor P.", mcc: 4829, category: TRANSFERS, amount: 3_000_000,
      note: "це я вивів свою зарплату з крипти через P2P",
    }]);
    assert.deepEqual(await verdictFor(d, "t1"), { verdict: "ask" });
  });

  await t.test("over the daily cap the note stops overriding, and the ordinary rules resume", async () => {
    const d = seedDb([{
      id: "t1", desc: "ATB 1234", mcc: 5411, category: GROCERIES, note: "ліки, не продукти",
    }]);
    const env = testEnv(d) as unknown as Env;
    // Spend the allowance. A leaked §QUICK-ADD token is unattended, so the cap is the only thing
    // between a forged note and an all-night run of Sonnet calls.
    const { DAILY_NOTE_ENRICH } = await import("../lib/platform/quota.ts");
    const { setState } = await import("../lib/finance/repo.ts");
    const { localYmd } = await import("../lib/finance/stats.ts");
    await setState(d, `note_enrich_${localYmd(Math.floor(Date.now() / 1000))}`, String(DAILY_NOTE_ENRICH));

    const row = await gateRow(env, "t1");
    const v = await enrichVerdict(env, row!);
    // Not dropped — treated exactly as it was before the override existed.
    assert.equal(v.verdict, "skip");
  });
});
