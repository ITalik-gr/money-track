/**
 * The demo fixture must fit the taxonomy the migrations actually build.
 *
 * WHY THIS EXISTS. `worker/demo/dataset.json` is a dump of the owner's object and it carries NO
 * `categories` table — the sandbox relies on the seeded taxonomy that migrations 0002/0005 create.
 * So a category id in the fixture is a reference into a table maintained somewhere else entirely,
 * and nothing connected the two.
 *
 * Then migration 0047 (§SUBS-CAT) removed «Підписки». On a fresh demo object the delete succeeds —
 * the object is empty, so every guard passes — and the dump then arrives carrying two
 * `receipt_items` rows filed under the id that had just been removed. Result: `GET /demo` answered
 * **503 for every visitor**, with `[demo] seed failed: FOREIGN KEY constraint failed` in the logs
 * and nothing on the page saying which row or which table. Found by curling the deploy, not by the
 * build — 811 tests were green.
 *
 * ⚠️ The rule this pins is not «12 is gone». It is that **a taxonomy migration and a fixture that
 * references the taxonomy are one change**, and the fixture is the half nobody remembers. The
 * check is mechanical so the next one cannot be forgotten either.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migratedDb } from "./harness.ts";

/** Every column in the fixture that is a reference into `categories`. */
const CATEGORY_COLUMNS = ["category_id", "real_category_id", "parent_id"];

test("demo fixture: every category it names exists after the migrations run", () => {
  const here = fileURLToPath(new URL(".", import.meta.url).href);
  const dataset = JSON.parse(readFileSync(`${here}../demo/dataset.json`, "utf8")) as
    Record<string, unknown>;

  const db = migratedDb();
  const known = new Set(
    (db.raw.prepare("SELECT id FROM categories").all() as { id: number }[]).map((r) => r.id),
  );
  assert.ok(known.size > 20, "the seeded taxonomy is there to compare against");

  const dangling: string[] = [];
  for (const [table, rows] of Object.entries(dataset)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      if (!row || typeof row !== "object") continue;
      for (const col of CATEGORY_COLUMNS) {
        const id = row[col];
        if (typeof id === "number" && !known.has(id)) dangling.push(`${table}.${col} = ${id}`);
      }
    }
  }

  assert.deepEqual([...new Set(dangling)], [],
    "the demo fixture references categories the migrations do not create. Every demo visitor " +
    "gets a 503 (FOREIGN KEY constraint failed) until either the fixture is re-filed or the " +
    "migration keeps the category.");
});
