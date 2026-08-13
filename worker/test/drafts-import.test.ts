/**
 * "Your statement has gone stale" — the nudge for accounts no API can feed.
 *
 * Worth testing rather than eyeballing because both failure directions are silent: too eager and
 * the app nags someone whose bank syncs itself; too quiet and a month of spending is simply
 * missing while every screen looks healthy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { draftStaleImports } from "../lib/messaging/drafts-import.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const DAY = 86400;

/** An imported row on `acc-uah`, `age` days old. */
function imported(db: MemDb, id: string, ageDays: number, now: number): void {
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, created_at)
     VALUES (?, 'acc-uah', 'import', ?, -1000, 980, ?)`,
  ).run(id, now - ageDays * DAY, now);
}

function env(db: MemDb): Env {
  return testEnv(db) as unknown as Env;
}

test("stale imports: a file-fed account that has gone quiet", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  const now = Math.floor(Date.now() / 1000);
  try {
    await t.test("silent for 40 days → one nudge, naming the account and the age", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE accounts SET provider = 'manual' WHERE id = 'acc-uah'").run();
      imported(db, "imp-old", 40, now);

      const drafts = await draftStaleImports(env(db), now);
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0]!.kind, "todo");
      assert.equal(drafts[0]!.tkey, "stale_import");
      assert.equal(drafts[0]!.tparams?.days, 40);
      assert.equal(drafts[0]!.tparams?.account, "Картка ₴");
      // Routes to the import card, not to the account list: the account list cannot fix this.
      assert.equal(drafts[0]!.entity_type, "import");
    });

    await t.test("a recent import is not a nudge", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE accounts SET provider = 'manual' WHERE id = 'acc-uah'").run();
      imported(db, "imp-fresh", 10, now);
      assert.deepEqual(await draftStaleImports(env(db), now), []);
    });

    await t.test("the NEWEST import decides, not the oldest", async () => {
      // A statement covers months, so an account holding a two-year-old row is normal. Reading the
      // oldest would nag everyone forever.
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE accounts SET provider = 'manual' WHERE id = 'acc-uah'").run();
      imported(db, "imp-ancient", 400, now);
      imported(db, "imp-recent", 3, now);
      assert.deepEqual(await draftStaleImports(env(db), now), []);
    });

    await t.test("a bank we can FETCH from is never nudged", async () => {
      // monobank pushes and PrivatBank is polled; asking the owner to fetch a file for those would
      // be the app requesting work it already does itself.
      for (const provider of ["mono", "privat"]) {
        const db = migratedDb();
        seed(db);
        db.raw.prepare("UPDATE accounts SET provider = ? WHERE id = 'acc-uah'").run(provider);
        imported(db, "imp-old", 90, now);
        assert.deepEqual(await draftStaleImports(env(db), now), [], provider);
      }
    });

    await t.test("an account that was never imported into is not nudged", async () => {
      // Nothing has gone stale — the owner simply does not use this path for this account, and a
      // reminder about a chore nobody started is noise.
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE accounts SET provider = 'manual' WHERE id = 'acc-uah'").run();
      assert.deepEqual(await draftStaleImports(env(db), now), []);
    });

    await t.test("one nudge per account per month", async () => {
      const db = migratedDb();
      seed(db);
      db.raw.prepare("UPDATE accounts SET provider = 'manual' WHERE id = 'acc-uah'").run();
      imported(db, "imp-old", 40, now);
      const first = await draftStaleImports(env(db), now);
      const later = await draftStaleImports(env(db), now + 5 * DAY);
      // Same dedup key within the same Kyiv month, so the feed stores it once.
      assert.equal(first[0]!.dedup_key, later[0]!.dedup_key);
    });
  } finally {
    restore();
  }
});
