/**
 * Characterization tests for the INGEST path — the monobank webhook.
 *
 * Why this file exists separately from `writes.test.ts`: everything in that suite is reached by
 * the user pressing something, so a mistake there shows up as a wrong screen. This path has no
 * user on the other end. A mistake here shows up as **a transaction that silently never arrives**
 * — no error, no red snapshot, just money missing from a report weeks later. That asymmetry is
 * exactly why the last inline queries in the route layer are still un-migrated (ARCHITECTURE.md,
 * phase 1 tail): they must not be moved until something can prove the path still works.
 *
 * These tests are that something. They are deliberately about the DATABASE STATE, not the
 * response: the webhook answers `ok` to almost everything on purpose, because monobank retries
 * forever otherwise — so the response says nothing at all about whether the event was stored.
 *
 * Not covered, and deliberately: transfer pairing, AI enrichment and the Telegram alert. All
 * three are best-effort branches wrapped in `try/catch`, and all three are skipped when no API
 * key is present — which is the case in `testEnv`. Their absence is what keeps these tests fast
 * and deterministic; their behaviour is covered where it is decided, not here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webhook } from "../routes/webhook.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "ingest");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function rows(db: MemDb, sql: string): unknown[] {
  return db.raw.prepare(sql).all() as unknown[];
}

/**
 * What a webhook event may touch: the transaction it carries, and the balance of the account it
 * arrived on. The balance is in the probe because it is the half nobody would think to check —
 * the row lands correctly while the account silently keeps a stale balance, and the dashboard
 * then disagrees with the feed.
 */
function probe(db: MemDb): Record<string, unknown> {
  return {
    transactions: rows(db,
      `SELECT id, account_id, time, amount, currency_code, mcc, merchant, comment, hold,
              balance_after, category_id, is_transfer
       FROM transactions ORDER BY id`),
    accounts: rows(db, "SELECT id, balance, updated_at FROM accounts ORDER BY id"),
  };
}

/** A monobank statement item, with only the fields the handler reads spelled out per scenario. */
function statementItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hook-tx-1",
    time: 1_778_000_000,
    description: "Сільпо",
    mcc: 5411,
    originalMcc: 5411,
    amount: -25_000,
    operationAmount: -25_000,
    currencyCode: 980,
    commissionRate: 0,
    cashbackAmount: 0,
    balance: 500_000,
    hold: false,
    ...over,
  };
}

interface Scenario {
  name: string;
  /** One event, or a sequence delivered in order — a hold and its settlement are two events. */
  body: unknown | unknown[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "webhook: a statement item is stored and the balance follows it",
    body: { type: "StatementItem", data: { account: "acc-uah", statementItem: statementItem() } },
  },
  {
    // The same id arriving twice is NORMAL, not an error: monobank re-sends an event when a hold
    // settles, with the same id and a (possibly) different amount. Storing it twice would double
    // the money, which is why this is the scenario worth having above all the others here.
    name: "webhook: a hold and its settlement are one row, not two",
    body: [
      { type: "StatementItem", data: { account: "acc-uah", statementItem: statementItem({ id: "hook-settle", amount: -25_000, hold: true }) } },
      { type: "StatementItem", data: { account: "acc-uah", statementItem: statementItem({ id: "hook-settle", amount: -27_500, hold: false, balance: 497_500 }) } },
    ],
  },
  {
    // A hold is a real expense as far as the canon is concerned (§Витрата in CLAUDE.md), so it
    // must land like any other row rather than being held back until it settles.
    name: "webhook: a hold is stored like any other expense",
    body: { type: "StatementItem", data: { account: "acc-uah", statementItem: statementItem({ id: "hook-hold", hold: true }) } },
  },
  {
    name: "webhook: an income item keeps its positive sign",
    body: { type: "StatementItem", data: { account: "acc-uah", statementItem: statementItem({ id: "hook-in", amount: 1_000_000, operationAmount: 1_000_000, description: "Зарплата", mcc: 4829 }) } },
  },
  {
    // Foreign currency: `amount` is in the ACCOUNT's currency and `operationAmount` in the
    // operation's. Mixing them up is the §R2-CUR1 invariant failing silently.
    name: "webhook: a foreign-currency item keeps both amounts",
    body: { type: "StatementItem", data: { account: "acc-uah", statementItem: statementItem({ id: "hook-usd", amount: -41_000, operationAmount: -1_000, currencyCode: 840, description: "Steam" }) } },
  },
  {
    // Unknown event types are ACKed rather than rejected: a 4xx makes monobank retry the same
    // payload forever, and a shape we do not understand is not a failure on our side.
    name: "webhook: an unknown event type is acked and stores nothing",
    body: { type: "SomethingElse", data: {} },
  },
  {
    name: "webhook: a StatementItem with no item is acked and stores nothing",
    body: { type: "StatementItem", data: { account: "acc-uah" } },
  },
  {
    // ⚠️ CHARACTERIZATION, NOT ENDORSEMENT. `transactions.account_id` is `NOT NULL REFERENCES
    // accounts(id)` and foreign keys are enforced in the Durable Object too, so an event for an
    // account we have not synced yet fails with a 500 and the row is LOST until monobank retries.
    // Nobody knew this; it is filed in ROADMAP.md. Recorded here so a fix is a visible diff.
    name: "webhook: an event for an unknown account is rejected by the foreign key",
    body: { type: "StatementItem", data: { account: "acc-unknown", statementItem: statementItem({ id: "hook-orphan" }) } },
  },
];

test("golden: the monobank webhook leaves the same database state", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

    for (const sc of SCENARIOS) {
      await t.test(sc.name, async () => {
        // A fresh database per scenario: these mutate, and the settle-in-place case depends on
        // the fixture row being untouched by the ones before it.
        const db = migratedDb();
        seed(db);
        const env = testEnv(db);

        const events = Array.isArray(sc.body) ? sc.body : [sc.body];
        let text = "", status = 0;
        for (const event of events) {
          const res = await webhook.request(
            "/secret-token",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(event),
            },
            env,
            // `waitUntil` — the handler schedules the per-transaction alert on it. Swallowing the
            // promise keeps the test deterministic; the alert path has no key here anyway.
            { waitUntil: (p: Promise<unknown>) => { void p; }, passThroughOnException: () => {}, props: {} },
          );
          status = res.status;
          text = await res.text();
        }

        const actual = JSON.stringify({ status, body: text, db: probe(db) }, null, 2);
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
