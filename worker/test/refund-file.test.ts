/**
 * §REFUND-FILE — a card merchant's refund is filed under its charges' category, not under the
 * income category «Повернення» (17), where §REFUND cannot see it and it inflates income.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { refundCategoryFor, REFUND_INCOME_CAT } from "../lib/ai/enrich-history.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import type { Env } from "../env.ts";

/** Seeded expense ids: 8 «Дім і побут», 1 «Продукти». */
const HOME = 8, GROCERIES = 1;

interface Seed { id: string; desc: string; amount: number; mcc?: number | null; category?: number | null }

function seedDb(rows: Seed[]): MemDb {
  const d = migratedDb();
  d.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('acc1', 'black', 'Картка', 980, 100000, 0, 1, 0)`,
  ).run();
  for (const s of rows) {
    d.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, mcc,
                                 category_id, raw_json)
       VALUES (?, 'acc1', 'mono', 1790000000, ?, 980, ?, ?, ?, ?)`,
    ).run(s.id, s.amount, s.desc, s.mcc ?? null, s.category ?? null, JSON.stringify({ description: s.desc }));
  }
  return d;
}

const MIGRATION = readFileSync(fileURLToPath(new URL("../../migrations/0059_refund_category.sql", import.meta.url).href), "utf8");
const catOf = (d: MemDb, id: string) =>
  (d.raw.prepare("SELECT category_id AS c FROM transactions WHERE id = ?").get(id) as { c: number | null }).c;

test("§REFUND-FILE: a shop refund goes back to its charges' category", async (t) => {
  await t.test("the owner's case: a Rozetka return finds the category of Rozetka's charges", async () => {
    const d = seedDb([
      { id: "c1", desc: "Rozetka", amount: -344800, mcc: 5964, category: HOME },
      { id: "c2", desc: "Rozetka", amount: -219900, mcc: 5964, category: HOME },
      { id: "c3", desc: "Rozetka", amount: -50000, mcc: 5964, category: GROCERIES },
      { id: "r1", desc: "Rozetka", amount: 99900, mcc: 5964, category: REFUND_INCOME_CAT },
    ]);
    const env = testEnv(d) as unknown as Env;
    const row = { id: "r1", merchant: "Rozetka", mcc: 5964, amount: 99900, raw_json: JSON.stringify({ description: "Rozetka" }) };
    assert.equal(await refundCategoryFor(env, row), HOME);
  });

  await t.test("money a person sends back (P2P 4829) is left alone", async () => {
    const d = seedDb([{ id: "c1", desc: "Кирило", amount: -10000, mcc: 4829, category: HOME }]);
    const env = testEnv(d) as unknown as Env;
    const row = { id: "r1", merchant: "Кирило", mcc: 4829, amount: 10000, raw_json: JSON.stringify({ description: "Кирило" }) };
    assert.equal(await refundCategoryFor(env, row), null);
  });

  await t.test("a merchant with no charges has nothing to return to", async () => {
    const d = seedDb([]);
    const env = testEnv(d) as unknown as Env;
    const row = { id: "r1", merchant: "Sollas", mcc: 5734, amount: 1000000, raw_json: null };
    assert.equal(await refundCategoryFor(env, row), null);
  });

  await t.test("migration 0059 repairs stored rows and spares P2P and lone receipts", () => {
    const d = seedDb([
      { id: "c1", desc: "Cloudflare", amount: -4600, mcc: 7372, category: HOME },
      { id: "r1", desc: "Cloudflare", amount: 4600, mcc: 7372, category: REFUND_INCOME_CAT },
      { id: "p1", desc: "Кирило", amount: -4600, mcc: 4829, category: HOME },
      { id: "p2", desc: "Кирило", amount: 4600, mcc: 4829, category: REFUND_INCOME_CAT },
      { id: "x1", desc: "Unknown shop", amount: 4600, mcc: 5999, category: REFUND_INCOME_CAT },
    ]);
    d.raw.prepare(
      `INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, is_transfer, source, created_at)
       VALUES ('mono_desc', 'Cloudflare', 'Cloudflare', 17, 0, 'ai', 0)`,
    ).run();
    d.raw.exec(MIGRATION);
    assert.equal(catOf(d, "r1"), HOME);
    assert.equal(catOf(d, "p2"), REFUND_INCOME_CAT);
    assert.equal(catOf(d, "x1"), REFUND_INCOME_CAT);
    const alias = d.raw.prepare("SELECT COUNT(*) AS n FROM merchant_aliases WHERE raw_key = 'Cloudflare'").get() as { n: number };
    assert.equal(alias.n, 0, "an alias that would file the next charge as income is dropped");
  });
});
