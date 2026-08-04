/**
 * Characterization tests for the WRITE endpoints (phase 1, batch B2).
 *
 * The read-only suite in `golden.test.ts` guards what the API *returns*. It cannot guard these:
 * the interesting output of a write is the state left in the database, and the response body is
 * usually just `{ok: true}`. So every scenario here snapshots BOTH — the response and a probe of
 * the rows the write is allowed to touch.
 *
 * Why the probe is wider than the row being written: these handlers are the ones that maintain
 * DENORMALISED columns the canon reads. `rbRecalc` writes `reimbursed` on the expense AND
 * `reimburses_total` on every source it touched, and §COMPENSATION was already revised once (v2)
 * because the first model let money disappear from both spending and income. A probe narrowed to
 * "the row in the URL" would go green through exactly that class of bug.
 *
 * Error paths are scenarios too, and deliberately so. Most of the logic in these handlers IS the
 * validation — the currency guard, the split/compensation exclusion, the ceiling at the expense
 * total — and each of those rules exists because of a specific way the data can go wrong. A
 * refactor that quietly drops one would otherwise pass.
 *
 * Re-record with `UPDATE_GOLDEN=1 npm test`, only for a deliberate, explained change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { api } from "../routes/api.ts";
import { migratedDb, testEnv, freezeTime, freezeUuid, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "writes");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function rows(db: MemDb, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const s = db.raw.prepare(sql);
  s.setReadBigInts(false);
  return s.all(...(params as never[])) as Record<string, unknown>[];
}

/** The id of a fixture transaction, looked up by merchant — sequence numbers would be brittle. */
function txId(db: MemDb, merchant: string): string {
  const r = rows(db, "SELECT id FROM transactions WHERE merchant = ? ORDER BY id LIMIT 1", [merchant]);
  assert.ok(r.length, `fixture has no transaction for merchant "${merchant}"`);
  return r[0]!.id as string;
}

/**
 * State after the write.
 *
 * Only the columns a write endpoint may legitimately change, so an unrelated schema addition does
 * not churn every golden file. Ordered by id, which is stable because the fixture assigns
 * sequential ids and `freezeUuid` makes generated ones deterministic.
 */
function probe(db: MemDb): Record<string, unknown> {
  return {
    transactions: rows(db,
      `SELECT id, amount, currency_code, category_id, real_category_id, is_transfer, transfer_pair_id,
              importance, name_locked, merchant, user_note, event_id, reimbursed, reimburses_total
       FROM transactions ORDER BY id`),
    tx_splits: rows(db, "SELECT tx_id, category_id, amount FROM tx_splits ORDER BY tx_id, category_id"),
    tx_reimbursements: rows(db,
      "SELECT expense_id, source_tx_id, amount FROM tx_reimbursements ORDER BY expense_id, source_tx_id"),
    transaction_tags: rows(db,
      "SELECT transaction_id, category_id FROM transaction_tags ORDER BY transaction_id, category_id"),
    merchant_aliases: rows(db,
      `SELECT match_type, raw_key, display_name, category_id, is_transfer, real_category_id, source
       FROM merchant_aliases ORDER BY raw_key`),
  };
}

interface Scenario {
  name: string;
  method: "POST" | "PUT" | "PATCH";
  /** Built from the seeded db, so a scenario can address fixture rows by merchant. */
  path: (db: MemDb) => string;
  body?: (db: MemDb) => unknown;
  /** Omit the request body entirely — several handlers treat that as "clear". */
  noBody?: boolean;
}

const SCENARIOS: Scenario[] = [
  // ---- §COMPENSATION: the arithmetic-heavy endpoint --------------------------------------
  {
    name: "reimbursement: explicit amount replaces the existing allocation",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: друг 2"), amount: 150000 }] }),
  },
  {
    name: "reimbursement: omitted amount takes min(free remainder, uncovered part)",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: друг 2"), amount: null }] }),
  },
  {
    name: "reimbursement: one source spread across two expenses",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Готель")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: друг 2"), amount: 100000 }] }),
  },
  {
    name: "reimbursement: empty body clears everything",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/reimbursement`,
    noBody: true,
  },
  {
    name: "reimbursement: manual amount, no source row",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/reimbursement`,
    body: () => ({ manual_amount: 70000 }),
  },
  {
    name: "reimbursement: rejected — more than the source has left",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: друг 2"), amount: 300000 }] }),
  },
  {
    name: "reimbursement: rejected — total above the expense itself",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Готель")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: колега"), amount: 180000 }], manual_amount: 50000 }),
  },
  {
    name: "reimbursement: rejected — source in another currency",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Хмара")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: друг") }] }),
  },
  {
    name: "reimbursement: rejected — the expense is split",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Ашан")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: друг") }] }),
  },
  {
    name: "reimbursement: rejected — target is income, not an expense",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Від: друг")}/reimbursement`,
    body: (db) => ({ allocations: [{ source_id: txId(db, "Від: колега") }] }),
  },
  {
    name: "reimbursement: rejected — unknown source id",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/reimbursement`,
    body: () => ({ allocations: [{ source_id: "no-such-tx" }] }),
  },

  // ---- §SPLIT ------------------------------------------------------------------------------
  {
    name: "splits: two parts summing to the transaction",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Кафе")}/splits`,
    body: () => ({ splits: [{ category_id: 2, amount: -20000 }, { category_id: 1, amount: -15000 }] }),
  },
  {
    name: "splits: empty array removes the split",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Ашан")}/splits`,
    body: () => ({ splits: [] }),
  },
  {
    name: "splits: rejected — parts do not sum to the transaction",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Кафе")}/splits`,
    body: () => ({ splits: [{ category_id: 2, amount: -20000 }, { category_id: 1, amount: -10000 }] }),
  },
  {
    name: "splits: rejected — a single part is not a split",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Кафе")}/splits`,
    body: () => ({ splits: [{ category_id: 2, amount: -35000 }] }),
  },
  {
    name: "splits: rejected — the expense is already reimbursed",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Квитки")}/splits`,
    body: () => ({ splits: [{ category_id: 11, amount: -200000 }, { category_id: 1, amount: -100000 }] }),
  },
  {
    name: "splits: rejected — income cannot be split",
    method: "PUT",
    path: (db) => `/transactions/${txId(db, "Від: друг")}/splits`,
    body: () => ({ splits: [{ category_id: 15, amount: -60000 }, { category_id: 1, amount: -60000 }] }),
  },

  // ---- PATCH one transaction ---------------------------------------------------------------
  {
    name: "patch: renaming the merchant locks the name (§R7)",
    method: "PATCH",
    path: (db) => `/transactions/${txId(db, "Кафе")}`,
    body: () => ({ merchant: "Кав'ярня на розі", category_id: 2 }),
  },
  {
    name: "patch: explicit lock_name=false wins over the rename",
    method: "PATCH",
    path: (db) => `/transactions/${txId(db, "Кафе")}`,
    body: () => ({ merchant: "Кав'ярня на розі", lock_name: false }),
  },
  {
    name: "patch: real_category_id is wiped outside bucket 13 (§R2-TX4)",
    method: "PATCH",
    path: (db) => `/transactions/${txId(db, "Кафе")}`,
    body: () => ({ real_category_id: 5 }),
  },
  {
    name: "patch: real_category_id survives inside bucket 13",
    method: "PATCH",
    path: (db) => `/transactions/${txId(db, "Зняття готівки")}`,
    body: () => ({ real_category_id: 2 }),
  },
  {
    name: "patch: tags replace the whole set and drop the main category",
    method: "PATCH",
    path: (db) => `/transactions/${txId(db, "Обід")}`,
    body: () => ({ category_id: 2, tags: [2, 5, 6, 7, 8] }),
  },
  {
    name: "patch: importance override",
    method: "PATCH",
    path: (db) => `/transactions/${txId(db, "Таксі")}`,
    body: () => ({ importance: "essential" }),
  },

  // ---- bulk --------------------------------------------------------------------------------
  {
    name: "bulk: category and importance across two rows",
    method: "POST",
    path: () => "/transactions/bulk",
    body: (db) => ({ ids: [txId(db, "Кафе"), txId(db, "Обід")], category_id: 6, importance: "optional" }),
  },
  {
    name: "bulk: tags are added, not replaced, and unknown ids are dropped (§FK-GUARD)",
    method: "POST",
    path: () => "/transactions/bulk",
    body: (db) => ({ ids: [txId(db, "Кафе")], tag_ids: [5, 999999] }),
  },
  {
    name: "bulk: rejected — importance outside the allowed set",
    method: "POST",
    path: () => "/transactions/bulk",
    body: (db) => ({ ids: [txId(db, "Кафе")], importance: "critical" }),
  },
  {
    name: "bulk: empty id list is a no-op",
    method: "POST",
    path: () => "/transactions/bulk",
    body: () => ({ ids: [], category_id: 6 }),
  },

  // ---- manual transfer ---------------------------------------------------------------------
  {
    name: "transfer: same currency writes a pair",
    method: "POST",
    path: () => "/transactions/transfer",
    body: () => ({ from_account_id: "acc-uah", to_account_id: "acc-jar", amount: 100000, time: 1778000000 }),
  },
  {
    name: "transfer: cross-currency needs both amounts",
    method: "POST",
    path: () => "/transactions/transfer",
    body: () => ({ from_account_id: "acc-uah", to_account_id: "acc-usd", amount: 400000, to_amount: 10000, time: 1778000000 }),
  },
  {
    name: "transfer: rejected — cross-currency without to_amount",
    method: "POST",
    path: () => "/transactions/transfer",
    body: () => ({ from_account_id: "acc-uah", to_account_id: "acc-usd", amount: 400000 }),
  },
  {
    name: "transfer: rejected — same account on both sides",
    method: "POST",
    path: () => "/transactions/transfer",
    body: () => ({ from_account_id: "acc-uah", to_account_id: "acc-uah", amount: 100000 }),
  },

  // ---- transfer review ---------------------------------------------------------------------
  {
    name: "transfers review: sets the real category on a bucket-13 row",
    method: "POST",
    path: () => "/transfers/review/save",
    body: (db) => ({ items: [{ id: txId(db, "Зняття готівки"), real_category_id: 2 }] }),
  },
];

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

test("golden: write endpoints leave the same database state", async (t) => {
  const restoreTime = freezeTime(FROZEN_NOW_ISO);
  const restoreUuid = freezeUuid();
  try {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

    for (const sc of SCENARIOS) {
      await t.test(sc.name, async () => {
        // A FRESH database per scenario — unlike the read suite, these mutate, and a shared
        // fixture would make each case depend on the order of the ones before it.
        const db = migratedDb();
        seed(db);
        const env = testEnv(db);

        const init: RequestInit = { method: sc.method };
        if (!sc.noBody) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(sc.body ? sc.body(db) : {});
        }

        const res = await api.request(sc.path(db), init, env);
        const text = await res.text();
        const actual = JSON.stringify({
          status: res.status,
          body: text ? JSON.parse(text) : null,
          db: probe(db),
        }, null, 2);

        const file = join(GOLDEN_DIR, `${slug(sc.name)}.json`);
        if (UPDATE || !existsSync(file)) {
          writeFileSync(file, actual + "\n");
          t.diagnostic(`recorded baseline: ${slug(sc.name)}.json`);
          return;
        }
        assert.equal(actual, readFileSync(file, "utf8").trimEnd(),
          `"${sc.name}" changed. Either the refactor broke it, or the change was intended — ` +
          `if intended, re-record with UPDATE_GOLDEN=1.`);
      });
    }
  } finally {
    restoreUuid();
    restoreTime();
  }
});
