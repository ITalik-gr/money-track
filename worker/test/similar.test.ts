/**
 * "Mark the similar ones too" — the rules that decide WHICH rows are offered.
 *
 * Assertions rather than a golden: every line here is a policy someone could reasonably have
 * chosen differently, and a golden would only prove the numbers did not move — not that the
 * policy is the one we meant. The two that matter most are the ones that protect existing work:
 * a row already filed the same way is not offered at all, and a row filed DIFFERENTLY is offered
 * but never pre-ticked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { SimilarTxList } from "../../shared/api/transactions.ts";

/** A Raiffeisen-shaped card-to-card row: the same wording, a different card number each time. */
function transferRow(db: MemDb, id: string, card: string, category: number | null): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, mcc, merchant, category_id, created_at)
     VALUES (?, 'acc-uah', 'import', 1778000000, -300000, 980, 6012, ?, ?, 1778000000)`,
  ).run(id, `Money transfers: ${card}`, category);
}

async function similar(db: MemDb, id: string): Promise<SimilarTxList> {
  const res = await api.request(`/transactions/${id}/similar`, {}, testEnv(db) as never);
  assert.equal(res.status, 200);
  return await res.json() as SimilarTxList;
}

test("why this category", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    async function why(db: MemDb, id: string): Promise<Record<string, unknown>> {
      const res = await api.request(`/transactions/${id}/why`, {}, testEnv(db) as never);
      assert.equal(res.status, 200);
      return await res.json() as Record<string, unknown>;
    }

    await t.test("names the RULE that fires, not just the category", () => {
      // The whole point of the line: a category with no reason is either obviously right (the
      // line costs nothing) or wrong — and then the reason is the only thing that says which
      // knob to turn.
      const db = migratedDb();
      seed(db);
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, mcc, merchant, category_id, created_at)
         VALUES ('why-mcc', 'acc-uah', 'mono', 1778000000, -25000, 980, 5411, 'Сільпо', 1, 1778000000)`,
      ).run();
      return why(db, "why-mcc").then((r) => {
        assert.equal(r.source, "rule_mcc");
        assert.equal(r.detail, "5411");
        assert.equal(r.agrees, true);
      });
    });

    await t.test("reports DISAGREEMENT between the rules and what is stored", async () => {
      // Not auto-fixed and not hidden: the stored category may be a correction somebody made on
      // purpose, so repairing it silently would undo their work — but they have no other way to
      // find out the two have diverged.
      const db = migratedDb();
      seed(db);
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, mcc, merchant, category_id, created_at)
         VALUES ('why-conflict', 'acc-uah', 'mono', 1778000000, -25000, 980, 5411, 'Сільпо', 8, 1778000000)`,
      ).run();
      const r = await why(db, "why-conflict");
      assert.equal(r.agrees, false);
      // The category the rules point at travels with the answer — "they disagree" is useless
      // without "about what".
      assert.equal(typeof r.category_name, "string");
    });

    await t.test("no rule at all is stated as such, and distinguishes AI from a human", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, ai_enriched, created_at)
         VALUES ('why-ai', 'acc-uah', 'mono', 1778000000, -25000, 980, 'Щось незнайоме', 1, 1, 1778000000)`,
      ).run();
      const r = await why(db, "why-ai");
      assert.equal(r.source, null);
      assert.equal(r.ai_enriched, true);
    });

    await t.test("the RAW bank text is what gets explained", async () => {
      // Enrichment rewrites `merchant` to a clean name; the engine matched the raw line. Reading
      // the cleaned name would explain a decision using text the engine never saw.
      const db = migratedDb();
      seed(db);
      db.raw.prepare("INSERT INTO rules (match_type, pattern, category_id, priority) VALUES ('text', 'kyiv', 1, 100)").run();
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, raw_json, created_at)
         VALUES ('why-raw', 'acc-uah', 'mono', 1778000000, -25000, 980, 'Silpo', '{"description":"SILPO 4506 KYIV"}', 1778000000)`,
      ).run();
      const r = await why(db, "why-raw");
      assert.equal(r.source, "rule_text");
      assert.equal(r.detail, "kyiv");
    });
  } finally {
    restore();
  }
});

test("similar operations", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("finds rows whose names differ only in the noise", async () => {
      // The case this was built for: an exact-name match finds nothing here, because the card
      // number is part of the description and is different every time.
      const db = migratedDb();
      seed(db);
      transferRow(db, "mt-1", "4441 11** **** 4932", 13);
      transferRow(db, "mt-2", "4441 11** **** 5181", null);
      transferRow(db, "mt-3", "5408 81** **** 2714", null);

      const { token, items } = await similar(db, "mt-1");
      assert.equal(token, "transfers");
      assert.deepEqual(items.map((i) => i.id).sort(), ["mt-2", "mt-3"]);
      // Nothing is categorised yet, so every row is a gap and every row is pre-ticked.
      assert.equal(items.every((i) => i.suggested === 1), true);
    });

    await t.test("nothing to copy means nothing offered", async () => {
      // Standing on an uncategorised row, every other uncategorised row is ALREADY identical —
      // offering them would be offering to apply "no category", which changes nothing. The block
      // appears once this row has been decided, which is also when the question starts to mean
      // something.
      const db = migratedDb();
      seed(db);
      transferRow(db, "mt-1", "4441 11** **** 4932", null);
      transferRow(db, "mt-2", "4441 11** **** 5181", null);

      const { token, items } = await similar(db, "mt-1");
      assert.equal(token, "transfers");
      assert.deepEqual(items, []);
    });

    await t.test("a row already filed the same way is NOT offered", async () => {
      // The list answers "what would change". Padding it with rows that need nothing makes a
      // person read fifteen lines to find the three that matter.
      const db = migratedDb();
      seed(db);
      transferRow(db, "mt-1", "4441 11** **** 4932", 13);
      transferRow(db, "mt-same", "4441 11** **** 5181", 13);
      transferRow(db, "mt-gap", "5408 81** **** 2714", null);

      const { items } = await similar(db, "mt-1");
      assert.deepEqual(items.map((i) => i.id), ["mt-gap"]);
    });

    await t.test("a row filed DIFFERENTLY is offered but not pre-ticked", async () => {
      // Somebody decided that — the bank, the AI or the person. Offering it is right; ticking it
      // by default would make the app silently overwrite work already done.
      const db = migratedDb();
      seed(db);
      transferRow(db, "mt-1", "4441 11** **** 4932", 13);
      transferRow(db, "mt-other", "4441 11** **** 5181", 1);

      const { items } = await similar(db, "mt-1");
      assert.equal(items.length, 1);
      assert.equal(items[0]!.id, "mt-other");
      assert.equal(items[0]!.suggested, 0);
      // The current category travels with the row: deciding whether to overwrite requires
      // seeing what is being overwritten.
      assert.equal(typeof items[0]!.category_name, "string");
    });

    await t.test("a name with no usable token asks nothing", async () => {
      // "4441" alone is not a merchant. Returning every row that shares a digit would be worse
      // than returning none, because the list would look authoritative.
      const db = migratedDb();
      seed(db);
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, created_at)
         VALUES ('mt-num', 'acc-uah', 'import', 1778000000, -1000, 980, '4441 5181', 1778000000)`,
      ).run();
      const { token, items } = await similar(db, "mt-num");
      assert.equal(token, null);
      assert.deepEqual(items, []);
    });

    await t.test("an unknown operation is 404, not an empty list", async () => {
      // Empty would read as "nothing similar" — a real answer to a question that was never asked.
      const db = migratedDb();
      seed(db);
      const res = await api.request("/transactions/nope/similar", {}, testEnv(db) as never);
      assert.equal(res.status, 404);
    });
  } finally {
    restore();
  }
});
