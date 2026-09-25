/**
 * §CYR-CASE — SQLite folds ASCII only, so `LOWER(…) LIKE` misses capitalised Cyrillic. Lint C16
 * refuses the idiom; these pin that the replacement (`likeVariants`) actually matches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";
import { caseVariants, likeVariants } from "../lib/platform/text.ts";
import { findSimilar } from "../repo/transactions.ts";
import { merchantMatches } from "../repo/planning.ts";

test("caseVariants: as typed, lower, UPPER and Capitalised — Ukrainian letters included", () => {
  const v = caseVariants("київстар");
  for (const want of ["київстар", "КИЇВСТАР", "Київстар"]) assert.ok(v.includes(want), `missing ${want}`);
  // ї and ґ fold correctly (the Ukrainian locale, not a Latin-only upper-caser).
  assert.ok(caseVariants("ґудзик").includes("ҐУДЗИК"));
  // No duplicates for a term that is already one of its own variants.
  assert.equal(new Set(caseVariants("Silpo")).size, caseVariants("Silpo").length);
  assert.deepEqual(likeVariants("x").every((l) => l.startsWith("%") && l.endsWith("%")), true);
});

function tx(db: MemDb, id: string, merchant: string, desc: string, categoryId: number | null): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, created_at, merchant, raw_json, category_id)
     VALUES (?, 'acc-uah', 'mono', ?, -250_00, 980, ?, ?, ?, ?)`,
  ).run(id, 1_780_000_000, 1_780_000_000, merchant, JSON.stringify({ description: desc }), categoryId);
}

test("findSimilar: «київстар» finds the capitalised merchant and the UPPER-CASE bank description", async () => {
  const db = migratedDb(); seed(db);
  tx(db, "src", "Київстар", "KYIVSTAR", null);
  tx(db, "cap", "Київстар", "Поповнення", null);
  tx(db, "up", "Мобільний", "КИЇВСТАР ПОПОВНЕННЯ", null);
  tx(db, "other", "Сільпо", "СІЛЬПО", null);
  const rows = await findSimilar(db, "src", "київстар", { category_id: 5, is_transfer: 0 });
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ["cap", "up"]);
});

test("merchantMatches (plan search): «київстар» finds «КИЇВСТАР» — the spelling the old variants missed", async () => {
  const db = migratedDb(); seed(db);
  tx(db, "a", "КИЇВСТАР", "КИЇВСТАР", null);
  const hits = await merchantMatches(db, ["київстар"], 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].merchant, "КИЇВСТАР");
});
