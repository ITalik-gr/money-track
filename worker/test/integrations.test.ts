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

/**
 * The two decisions a row from a FILE must make the same way a row from a FEED does. Both were
 * quietly different until the two writers became one (BANKS.md §4.4), and neither difference was
 * ever chosen — they were simply written on different days:
 *   • the comment takes part in categorisation (§RULES-UI: the haystack is description + comment,
 *     in the engine and in the preview alike — the importer was a third opinion);
 *   • an obviously-internal description marks the row as a transfer (§Інваріанти lists insert-time
 *     detection as one of the five paths that set `is_transfer`), so the same "Поповнення власного
 *     рахунку" counted as spending when it arrived in a file and did not when it arrived by webhook.
 * Both are observable in the probe (`category_id`, `is_transfer`), so this file is where they are
 * decided from now on.
 */
const CSV_FEED_PARITY = [
  "Дата;Опис;Сума;MCC;Коментар",
  // The comment carries the literal pattern; matching is a plain lowercase substring, so a
  // declined form ("за ігротеку") would NOT match — which is a property of the rule engine the
  // rule screen shows the user, not something this test should paper over.
  "05.05.2026;Оплата;-500,00;;ігротека, настолки",
  "06.05.2026;Поповнення власного рахунку;-1000,00;;",
].join("\n");

/** A statement that names its own currency — the column the guesser finds but nothing used to read. */
const CSV_CURRENCY = [
  "Дата;Опис;Сума;Валюта",
  "01.05.2026;Steam;-10,00;USD",
].join("\n");

/**
 * A statement in the shape a bank actually EXPORTS: a preamble, then the table.
 *
 * Modelled on a real Raiffeisen export (2026-08-13), with the identity block replaced — the real
 * one carries the holder's tax id, passport number and address, and a fixture is committed
 * forever. What is kept is everything that broke the import: 5 rows above the header, English
 * column names written as phrases, and a "Details of the operation" column that matched no hint,
 * so the app declared a perfectly ordinary file unreadable.
 */
const CSV_WITH_PREAMBLE = [
  '"Raiffeisen Bank JSC"',
  '"Account statement for 13.08.2026 18:32:09"',
  '"Account: UA000000000000000000000000000"',
  '"Currency of account: UAH"',
  '"Balance at the end of period: 11121.930"',
  '"Date and time of transaction";"Date of transaction execution by the bank";"Card number";"Details of the operation";"MCC";"Amount in card currency";"Amount in transaction currency";"Currency";"Rate";"Fees";"Cashback";"Balance"',
  '"13.08.2026 08:52:03";"13.08.2026";;"Salary from EMPLOYER";"";"2084.00";"2084.00";;"";"0.00";"";"11121.93"',
  '"12.06.2026 21:40:00";"12.06.2026";"4149 50** **** 8439";"SILPO KYIV";"5411";"-250.00";"-250.00";"UAH";"";"0.00";"";"9037.93"',
].join("\n");

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
  /** Rows this scenario needs beyond the fixture. */
  setupDb?: (db: MemDb) => void;
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
    // `profileSet` decides the last step of the checklist, and it is derived from a text column
    // rather than from a flag — so it has to be pinned in BOTH states, or "always false" would
    // pass just as well and the step would never tick.
    name: "setup status: a written profile finishes the last step",
    app: "setup", path: "/status", method: "GET",
    setupDb: (db) => {
      db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('finance_profile', ?)")
        .run("Фрилансер, орендую житло.");
    },
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
    // The file that prompted `findHeaderRow`. Three separate defects met here: the guesser was
    // handed row 0 ("Raiffeisen Bank JSC") and mapped nothing; the description column is a
    // phrase no hint covered; and every row above the header would have been fed to the parser
    // as data. The preamble count is REPORTED, because a row that vanishes without a reason is
    // the one thing this path refuses to do.
    name: "import preview: a statement with a preamble finds its own header",
    app: "import", path: "/csv/preview",
    body: { text: CSV_WITH_PREAMBLE, account_id: "acc-uah" },
  },
  {
    // And it imports: the evening purchase must keep its own day (§APP_TZ — read as UTC, 21:40
    // on 12 June lands on the 13th), and the debit must stay negative.
    name: "import commit: a statement with a preamble lands with the right days and signs",
    app: "import", path: "/csv/commit",
    body: { text: CSV_WITH_PREAMBLE, account_id: "acc-uah" },
  },
  {
    // The account stays the authority over what an amount MEANS — but it is not the authority
    // over whether the right account was picked. A USD statement imported into a hryvnia account
    // stores every amount as hryvnia: wrong by the exchange rate, and completely ordinary-looking
    // afterwards. The preview is the last screen where that can still be stopped.
    name: "import preview: the file names a currency the account does not hold",
    app: "import", path: "/csv/preview",
    body: { text: CSV_CURRENCY, account_id: "acc-uah" },
  },
  {
    // The comment half. The rule matches a word that appears ONLY in the comment column, so a
    // categorised row proves the importer feeds the same haystack to the engine as the webhook
    // does. Priority 100 beats the seeded MCC rules; the MCC column is empty here anyway.
    name: "import commit: a rule matches text found only in the comment",
    app: "import", path: "/csv/commit", body: { text: CSV_FEED_PARITY, account_id: "acc-uah" },
    setupDb: (db) => {
      db.raw
        .prepare("INSERT INTO rules (match_type, pattern, category_id, priority) VALUES ('text', 'ігротека', 1, 100)")
        .run();
    },
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
        sc.setupDb?.(db);
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
