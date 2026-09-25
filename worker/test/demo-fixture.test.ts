/**
 * The demo dump carries no `categories` table, so every category id in it must exist after the
 * migrations. Migration 0047 once broke this and `/demo` answered 503 to every visitor.
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
