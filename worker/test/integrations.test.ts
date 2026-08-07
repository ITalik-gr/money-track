/**
 * Characterization tests for the INTEGRATION entry points — CSV import and the setup status the
 * first-run checklist reads.
 *
 * Same reason as `ingest.test.ts`, one step removed from the bank: these are the paths that put
 * OTHER people's data into the database, and nothing else in the suite touched them. They were
 * among the last files still holding inline SQL (`ARCHITECTURE.md` §5), and the rule for that tail
 * is that no query moves until something can prove the path still works. This file is that proof
 * for `import.ts` and `setup.ts` — both went to `repo/` the moment it went green.
 *
 * What each scenario is actually pinning down, so a later reader can tell a bug from a change:
 *  - the ACCOUNT decides the currency, never the file. A statement exported in one currency and
 *    imported into an account in another would otherwise store amounts under the wrong code, and
 *    the canon converts by `currency_code` — the error would surface as a wrong total, months on.
 *  - `duplicates` is counted BEFORE writing. "Imported 0 of 300" after the fact reads as a
 *    failure when it is the correct answer.
 *  - the id is a content hash, so re-importing an overlapping export is a no-op rather than
 *    double-counted money. This is the one that must never regress silently.
 *  - a bad row is SKIPPED with a reason, not fatal: a statement with one broken line still
 *    imports the other 299.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importRoutes } from "../routes/import.ts";
import { setup } from "../routes/setup.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "integrations");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function rows(db: MemDb, sql: string): Record<string, unknown>[] {
  const s = db.raw.prepare(sql);
  s.setReadBigInts(false);
  return s.all() as Record<string, unknown>[];
}

/**
 * Only the imported rows, not the whole table: the fixture's own transactions are irrelevant here
 * and would make every unrelated fixture change rewrite these files.
 */
function probe(db: MemDb): Record<string, unknown> {
  return {
    imported: rows(db,
      `SELECT id, account_id, source, time, amount, currency_code, mcc, merchant, comment,
              category_id, is_transfer
       FROM transactions WHERE source = 'import' ORDER BY time, id`),
  };
}

/** A small statement in the shape banks actually export: header, semicolons, decimal comma. */
const CSV = [
  "Дата;Опис;Сума;MCC",
  "01.05.2026;Сільпо;-250,00;5411",
  "02.05.2026;Зарплата;10000,00;4829",
  // Two rows that must be SKIPPED with a reason rather than aborting the file: a date the parser
  // cannot read, and a zero amount (a bank's balance line, not an operation).
  "не дата;Аптека;-100,00;5912",
  "04.05.2026;Нульова;0,00;5411",
].join("\n");

/** Headers a guesser cannot map — the branch that must ask instead of inventing columns. */
const CSV_UNMAPPABLE = ["col1;col2;col3", "a;b;c"].join("\n");

interface Scenario {
  name: string;
  app: "import" | "setup";
  path: string;
  method?: string;
  body?: unknown;
  /** Requests sent BEFORE the recorded one — for "the second import is a no-op". */
  before?: { path: string; body: unknown }[];
  /** Skip the fixture: the empty account is a state of its own (every new user starts there). */
  empty?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "setup status: a seeded account reports its counts",
    app: "setup", path: "/status", method: "GET",
  },
  {
    // A new user and the demo sandbox in its first minutes. The checklist reads these numbers to
    // decide which step is done, so zero must mean zero rather than null.
    name: "setup status: an empty account reports zeros",
    app: "setup", path: "/status", method: "GET", empty: true,
  },
  {
    name: "import preview: unmappable headers ask instead of guessing",
    app: "import", path: "/csv/preview", body: { text: CSV_UNMAPPABLE },
  },
  {
    name: "import preview: a mapped statement reports what it understood",
    app: "import", path: "/csv/preview", body: { text: CSV, account_id: "acc-uah" },
  },
  {
    name: "import preview: an empty file is rejected",
    app: "import", path: "/csv/preview", body: {},
  },
  {
    name: "import commit: rows land with the ACCOUNT's currency",
    app: "import", path: "/csv/commit", body: { text: CSV, account_id: "acc-uah" },
  },
  {
    // The account is USD while the file is the same one: the amounts must be stored as USD minor
    // units, because that is what the account holds. Nothing in the file says otherwise, and if
    // the file did say otherwise it would still lose — the account is the authority.
    name: "import commit: the file does not override the account currency",
    app: "import", path: "/csv/commit", body: { text: CSV, account_id: "acc-usd" },
  },
  {
    // The dedup guarantee, stated as behaviour rather than as a comment: the same statement twice
    // inserts nothing the second time, because the id is a hash of its content.
    name: "import commit: re-importing the same statement inserts nothing",
    app: "import", path: "/csv/commit", body: { text: CSV, account_id: "acc-uah" },
    before: [{ path: "/csv/commit", body: { text: CSV, account_id: "acc-uah" } }],
  },
  {
    name: "import preview: already-imported rows are counted as duplicates",
    app: "import", path: "/csv/preview", body: { text: CSV, account_id: "acc-uah" },
    before: [{ path: "/csv/commit", body: { text: CSV, account_id: "acc-uah" } }],
  },
  {
    name: "import commit: an unknown account is rejected",
    app: "import", path: "/csv/commit", body: { text: CSV, account_id: "nope" },
  },
  {
    name: "import commit: no account is rejected",
    app: "import", path: "/csv/commit", body: { text: CSV },
  },
];

test("golden: CSV import and setup status", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

    for (const sc of SCENARIOS) {
      await t.test(sc.name, async () => {
        const db = migratedDb();
        if (!sc.empty) seed(db);
        const env = testEnv(db);
        const app = sc.app === "import" ? importRoutes : setup;

        for (const pre of sc.before ?? []) {
          await app.request(pre.path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(pre.body),
          }, env);
        }

        const method = sc.method ?? "POST";
        const init: RequestInit = { method };
        if (method !== "GET") {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(sc.body ?? {});
        }
        const res = await app.request(sc.path, init, env);
        const text = await res.text();

        const actual = JSON.stringify(
          { status: res.status, body: text ? JSON.parse(text) : null, db: probe(db) },
          null, 2,
        );
        const file = join(GOLDEN_DIR, `${sc.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`);

        if (UPDATE || !existsSync(file)) {
          writeFileSync(file, actual + "\n");
          t.diagnostic(`recorded baseline: ${file.split("/").pop()}`);
          return;
        }
        assert.equal(actual, readFileSync(file, "utf8").trimEnd(),
          `"${sc.name}" changed. Either the refactor broke it, or the change was intended — ` +
          `if intended, re-record with UPDATE_GOLDEN=1.`);
      });
    }
  } finally {
    restore();
  }
});
