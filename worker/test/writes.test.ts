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
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, freezeUuid, freezeRandom, type MemDb } from "./harness.ts";
import {
  seed, seedCategoryCascade, seedPlanning, FROZEN_NOW_ISO,
  CASCADE_CAT, CASCADE_SUBCAT, CASCADE_TARGET,
  EVENT_ID, EVENT_PLANNED_ID, REPORT_ID,
} from "./fixture.ts";

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

/**
 * Probes a scenario can ask for on top of the default, when its blast radius is wider.
 *
 * Opt-in rather than always-on: every key added to `probe()` rewrites all 32 existing golden
 * files, and a churned baseline is one nobody reads. The category cascade is the case that needs
 * them — it reaches six tables no transaction write ever touches.
 */
const EXTRA_PROBES = {
  categories: (db: MemDb) =>
    rows(db, "SELECT id, name, parent_id, is_custom, importance FROM categories WHERE is_custom = 1 OR id <= 3 ORDER BY id"),
  // The seed ships ~100 MCC rules that no category delete can reach, and dumping them makes the
  // golden unreadable. Listing only the hand-written ones plus a total keeps the file legible
  // while still failing if the cascade ever takes a seeded rule with it.
  rules: (db: MemDb) => ({
    total: rows(db, "SELECT COUNT(*) AS n FROM rules")[0]!.n,
    custom: rows(db, "SELECT match_type, pattern, category_id FROM rules WHERE match_type <> 'mcc' ORDER BY id"),
  }),
  budgets: (db: MemDb) => rows(db, "SELECT category_id, period, amount, rollover FROM budgets ORDER BY id"),
  planned_payments: (db: MemDb) =>
    rows(db, `SELECT id, title, kind, total_amount, period_amount, period, period_count, start_date,
                     end_date, occurrences, category_id, currency_code, is_active, note
              FROM planned_payments ORDER BY id`),
  planned_dismissed: (db: MemDb) => rows(db, "SELECT merchant FROM planned_dismissed ORDER BY merchant"),
  receipt_items: (db: MemDb) => rows(db, "SELECT receipt_id, name, category_id FROM receipt_items ORDER BY id"),
  event_groups: (db: MemDb) => rows(db, "SELECT id, name, kind, note, budget, is_active FROM event_groups ORDER BY id"),
  event_planned: (db: MemDb) => rows(db, "SELECT id, event_id, label, amount, category_id FROM event_planned ORDER BY id"),
  ai_reports: (db: MemDb) => rows(db, "SELECT id, period_type, summary FROM ai_reports ORDER BY id"),
  accounts: (db: MemDb) =>
    rows(db, `SELECT id, type, title, currency_code, balance, credit_limit, role, ai_note, is_manual,
                     is_active, statement_day, payment_day, min_payment
              FROM accounts ORDER BY id`),
  account_balance_history: (db: MemDb) =>
    rows(db, "SELECT account_id, balance, recorded_at FROM account_balance_history ORDER BY id"),
  knowledge_docs: (db: MemDb) =>
    rows(db, "SELECT id, kind, title, summary, body, enabled FROM knowledge_docs ORDER BY id"),
  // §CHAT-SYNC. Both tables together, always: the whole point of moving conversations off the
  // device is that a chat and its turns stay one thing, and the failure worth catching is a
  // conversation whose messages outlive it (or the reverse).
  chats: (db: MemDb) => ({
    // `kind`/`entity_id` are in the probe since §TX-CHAT (migration 0040): a conversation about a
    // transaction must never land in the advisor's rail, and that is decided by these two columns.
    chats: rows(db, "SELECT id, title, created_at, updated_at, kind, entity_id FROM chats ORDER BY id"),
    messages: rows(db, "SELECT chat_id, role, content FROM chat_messages ORDER BY chat_id, id"),
  }),
  // §A1. `confirmed_at` and `source` are the two columns worth the snapshot: the first IS the
  // gate (only a confirmed fact with an adjustment moves burn and runway), and the second records
  // who authored the claim. A write that sets either of them wrongly does not fail visibly — it
  // quietly changes what the user's runway says.
  // §AI-AUDIT. `old_value` is what makes the log an undo, and `reverted_at` is what stops the
  // same undo being offered twice — both are worth a snapshot.
  ai_changes: (db: MemDb) =>
    rows(db, "SELECT id, tx_id, field, old_value, new_value, source, reverted_at FROM ai_changes ORDER BY id"),
  facts: (db: MemDb) =>
    rows(db, `SELECT id, text, effective_from, expires_at, category_id, adjust_kind, adjust_value,
                     confirmed_at, source FROM facts ORDER BY id`),
} satisfies Record<string, (db: MemDb) => unknown>;

interface Scenario {
  name: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
  /** Built from the seeded db, so a scenario can address fixture rows by merchant. */
  path: (db: MemDb) => string;
  body?: (db: MemDb) => unknown;
  /** Omit the request body entirely — several handlers treat that as "clear". */
  noBody?: boolean;
  /** Rows this scenario needs beyond the shared fixture, seeded after it. */
  setup?: (db: MemDb) => void;
  /** Tables to snapshot in addition to the default probe. */
  extraProbes?: (keyof typeof EXTRA_PROBES)[];
  /**
   * Narrow a response before it is snapshotted.
   *
   * Only for the full-backup export, whose body is the entire database: recording it would make
   * the golden a second copy of the fixture, so every unrelated change would rewrite it and
   * nobody would read the diff. Its meta block — the per-table row counts — is the part that
   * actually carries the guarantee, which is that the dump reads the table list from the SCHEMA
   * and so cannot silently miss a table a later migration added.
   */
  reduceBody?: (body: unknown) => unknown;
  /** Snapshot the response as TEXT — the CSV export is not JSON. */
  raw?: boolean;
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

  // ---- categories (batch C) ------------------------------------------------------------------
  {
    name: "categories: create a custom sub-category",
    method: "POST",
    path: () => "/categories",
    body: () => ({ name: "  Настільні ігри  ", color: "#123456", icon: "star", parent_id: 2, importance: "optional" }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: create falls back to defaults",
    method: "POST",
    path: () => "/categories",
    body: () => ({ name: "Без нічого" }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: create rejected — blank name",
    method: "POST",
    path: () => "/categories",
    body: () => ({ name: "   " }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: patch name, colour, importance and parent",
    method: "PATCH",
    path: () => "/categories/2",
    body: () => ({ name: " Кав'ярні ", color: "#ABCDEF", importance: "essential", parent_id: 1 }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: patch cannot make a category its own parent",
    method: "PATCH",
    path: () => "/categories/2",
    body: () => ({ parent_id: 2 }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: patch with no known fields is a no-op",
    method: "PATCH",
    path: () => "/categories/2",
    body: () => ({ nonsense: 1 }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: patch rejected — blank name",
    method: "PATCH",
    path: () => "/categories/2",
    body: () => ({ name: "  " }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: patch rejected — unknown id",
    method: "PATCH",
    path: () => "/categories/99999",
    body: () => ({ name: "Привид" }),
    extraProbes: ["categories"],
  },
  {
    name: "categories: usage counts transactions, tags and sub-categories",
    method: "GET",
    path: () => `/categories/${CASCADE_CAT}/usage`,
    setup: seedCategoryCascade,
  },
  {
    name: "categories: usage of an unused category is all zeroes",
    method: "GET",
    path: () => `/categories/${CASCADE_SUBCAT}/usage`,
    setup: seedCategoryCascade,
  },
  {
    // The whole cascade with a target: every FK moves rather than clears, tags de-duplicate
    // against the ones the target already has, and the sub-category is re-parented.
    name: "categories: delete reassigning everything to another category",
    method: "DELETE",
    path: () => `/categories/${CASCADE_CAT}?reassign=${CASCADE_TARGET}`,
    setup: seedCategoryCascade,
    extraProbes: ["categories", "rules", "budgets", "planned_payments", "receipt_items"],
  },
  {
    // The other half of the branch: links clear to NULL, and the NOT NULL rule is DELETED
    // rather than nulled — the one place in the cascade where "no target" is not "set null".
    name: "categories: delete without a target clears the links",
    method: "DELETE",
    path: () => `/categories/${CASCADE_CAT}`,
    setup: seedCategoryCascade,
    extraProbes: ["categories", "rules", "budgets", "planned_payments", "receipt_items"],
  },
  {
    name: "categories: delete treats reassign=none as no target",
    method: "DELETE",
    path: () => `/categories/${CASCADE_CAT}?reassign=none`,
    setup: seedCategoryCascade,
    extraProbes: ["categories", "rules"],
  },
  {
    name: "categories: delete ignores a reassign pointing at itself",
    method: "DELETE",
    path: () => `/categories/${CASCADE_CAT}?reassign=${CASCADE_CAT}`,
    setup: seedCategoryCascade,
    extraProbes: ["categories", "rules"],
  },
  {
    name: "categories: delete rejected — bucket 13 is locked",
    method: "DELETE",
    path: () => "/categories/13",
    extraProbes: ["categories"],
  },
  {
    name: "categories: delete rejected — unknown id",
    method: "DELETE",
    path: () => "/categories/99999",
    extraProbes: ["categories"],
  },

  // ---- budgets (batch D) ---------------------------------------------------------------------
  {
    // The table has NO unique index, so the handler replaces by delete-then-insert. A scenario
    // that set a budget on a fresh category would not exercise that at all.
    name: "budgets: setting one that already exists replaces it",
    method: "PUT",
    path: () => "/budgets",
    body: () => ({ category_id: 1, period: "month", amount: 2_000_00, rollover: true }),
    extraProbes: ["budgets"],
  },
  {
    name: "budgets: setting one on a category without a budget adds it",
    method: "PUT",
    path: () => "/budgets",
    body: () => ({ category_id: 3, period: "month", amount: 500_00 }),
    extraProbes: ["budgets"],
  },
  {
    // §BUDGET-ZERO: this used to be "a non-positive amount clears the envelope". It now STORES a
    // zero limit, because «сюди я свідомо не витрачаю» is a plan and deserves to be sayable — the
    // golden proves the row survives with `amount = 0` instead of disappearing.
    name: "budgets: a zero amount stores a deliberate zero limit",
    method: "PUT",
    path: () => "/budgets",
    body: () => ({ category_id: 2, period: "month", amount: 0 }),
    extraProbes: ["budgets"],
  },
  {
    // …and removing an envelope is now its own verb. Two rows in, one row out.
    name: "budgets: DELETE removes the envelope entirely",
    method: "DELETE",
    path: () => "/budgets/2?period=month",
    extraProbes: ["budgets"],
  },
  {
    // A negative limit is refused rather than clamped to 0: clamping would hide a caller's bug
    // behind an envelope that looks deliberate.
    name: "budgets: a negative amount is rejected",
    method: "PUT",
    path: () => "/budgets",
    body: () => ({ category_id: 2, period: "month", amount: -100 }),
    extraProbes: ["budgets"],
  },
  {
    name: "budgets: auto-apply replaces the chosen envelopes",
    method: "POST",
    path: () => "/budgets/auto",
    body: () => ({ items: [{ category_id: 1, amount: 9_000_00 }, { category_id: 6, amount: 800_00 }] }),
    extraProbes: ["budgets"],
  },
  {
    name: "budgets: auto-apply drops non-positive amounts and rejects an empty batch",
    method: "POST",
    path: () => "/budgets/auto",
    body: () => ({ items: [{ category_id: 1, amount: 0 }] }),
    extraProbes: ["budgets"],
  },

  // ---- planned payments ----------------------------------------------------------------------
  {
    name: "planned: create a subscription",
    method: "POST",
    path: () => "/planned",
    body: () => ({ title: "Музика", kind: "subscription", period_amount: 99_00, period: "month",
      start_date: 1778000000, category_id: 6, currency_code: 980 }),
    extraProbes: ["planned_payments"],
  },
  {
    // §6.5: occurrences and end_date are DERIVED here, and every "every N periods" plan gets
    // them wrong if `period_count` is dropped from the step.
    name: "planned: an instalment derives occurrences and end date",
    method: "POST",
    path: () => "/planned",
    body: () => ({ title: "Телефон", kind: "installment", total_amount: 30_000_00,
      period_amount: 5_000_00, period: "month", period_count: 2, start_date: 1778000000 }),
    extraProbes: ["planned_payments"],
  },
  {
    name: "planned: patch note and category",
    method: "PATCH",
    path: () => "/planned/1",
    body: () => ({ note: "  сімейна підписка  ", category_id: 42 }),
    extraProbes: ["planned_payments"],
  },
  {
    name: "planned: patch with no known fields is a no-op",
    method: "PATCH",
    path: () => "/planned/1",
    body: () => ({ nonsense: true }),
    extraProbes: ["planned_payments"],
  },
  {
    // Soft delete: the plan must stay readable, because past charges still point at it.
    name: "planned: delete only deactivates",
    method: "DELETE",
    path: () => "/planned/1",
    extraProbes: ["planned_payments"],
  },
  {
    name: "planned: dismissing a candidate stores it lower-cased",
    method: "POST",
    path: () => "/planned/dismiss",
    body: () => ({ merchant: "  Сільпо  " }),
    extraProbes: ["planned_dismissed"],
  },
  {
    name: "planned: dismissing the same merchant twice is idempotent",
    method: "POST",
    path: () => "/planned/dismiss",
    body: () => ({ merchant: "Таксі" }),
    setup: seedPlanning,
    extraProbes: ["planned_dismissed"],
  },
  {
    name: "planned: dismiss rejected — blank merchant",
    method: "POST",
    path: () => "/planned/dismiss",
    body: () => ({ merchant: "   " }),
    extraProbes: ["planned_dismissed"],
  },

  // ---- events --------------------------------------------------------------------------------
  {
    name: "events: detail rolls foreign-currency spending up in ₴",
    method: "GET",
    path: () => `/events/${EVENT_ID}`,
    setup: seedPlanning,
  },
  {
    name: "events: detail of an unknown event is 404",
    method: "GET",
    path: () => "/events/99999",
    setup: seedPlanning,
  },
  {
    name: "events: create",
    method: "POST",
    path: () => "/events",
    body: () => ({ name: "  Весілля  ", kind: "event", color: "#AA1122", note: "у липні" }),
    extraProbes: ["event_groups"],
  },
  {
    name: "events: create rejected — blank name",
    method: "POST",
    path: () => "/events",
    body: () => ({ name: " " }),
    extraProbes: ["event_groups"],
  },
  {
    name: "events: patch budget, name and note",
    method: "PATCH",
    path: () => `/events/${EVENT_ID}`,
    body: () => ({ budget: 25_000_00, name: "  Карпати 2026  ", note: "  подовжили  " }),
    setup: seedPlanning,
    extraProbes: ["event_groups"],
  },
  {
    name: "events: a non-positive budget clears the limit",
    method: "PATCH",
    path: () => `/events/${EVENT_ID}`,
    body: () => ({ budget: 0 }),
    setup: seedPlanning,
    extraProbes: ["event_groups"],
  },
  {
    name: "events: patch ignores a blank name",
    method: "PATCH",
    path: () => `/events/${EVENT_ID}`,
    body: () => ({ name: "   " }),
    setup: seedPlanning,
    extraProbes: ["event_groups"],
  },
  {
    // Two statements in order: the transactions are unlinked FIRST, then the event is archived.
    // The rows themselves survive — deleting an event must never delete spending.
    name: "events: delete unlinks the transactions and archives the event",
    method: "DELETE",
    path: () => `/events/${EVENT_ID}`,
    setup: seedPlanning,
    extraProbes: ["event_groups", "event_planned"],
  },
  {
    name: "events: add a plan line item",
    method: "POST",
    path: () => `/events/${EVENT_ID}/planned`,
    body: () => ({ label: "  Прокат  ", amount: 1_500_00, category_id: 3 }),
    setup: seedPlanning,
    extraProbes: ["event_planned"],
  },
  {
    name: "events: plan line item rejected — no label or amount",
    method: "POST",
    path: () => `/events/${EVENT_ID}/planned`,
    body: () => ({ label: "Прокат", amount: 0 }),
    setup: seedPlanning,
    extraProbes: ["event_planned"],
  },
  {
    // Scoped by event as well as by id: an id alone would let one event delete another's line.
    name: "events: delete a plan line item",
    method: "DELETE",
    path: () => `/events/${EVENT_ID}/planned/${EVENT_PLANNED_ID}`,
    setup: seedPlanning,
    extraProbes: ["event_planned"],
  },
  {
    name: "events: deleting a plan line item under the wrong event does nothing",
    method: "DELETE",
    path: () => `/events/99999/planned/${EVENT_PLANNED_ID}`,
    setup: seedPlanning,
    extraProbes: ["event_planned"],
  },

  // ---- stored reports ------------------------------------------------------------------------
  {
    name: "reports: read one back with its parsed payload",
    method: "GET",
    path: () => `/reports/${REPORT_ID}`,
    setup: seedPlanning,
  },
  {
    name: "reports: unknown id is 404",
    method: "GET",
    path: () => "/reports/99999",
    setup: seedPlanning,
  },
  {
    name: "reports: delete",
    method: "DELETE",
    path: () => `/reports/${REPORT_ID}`,
    setup: seedPlanning,
    extraProbes: ["ai_reports"],
  },
  {
    name: "reports: deleting an unknown id is not an error",
    method: "DELETE",
    path: () => "/reports/99999",
    setup: seedPlanning,
    extraProbes: ["ai_reports"],
  },

  // ---- accounts (batch E) --------------------------------------------------------------------
  {
    // Creating a manual account also writes the first balance SNAPSHOT. Without it the net-worth
    // chart has no point to start from and draws the account as if it appeared today.
    name: "accounts: creating a manual one snapshots its balance",
    method: "POST",
    path: () => "/accounts/manual",
    body: () => ({ type: "cash", title: "Готівка вдома", currency_code: 980, balance: 250000 }),
    extraProbes: ["accounts", "account_balance_history"],
  },
  {
    name: "accounts: an unknown type falls back to a manual card, role to liquid",
    method: "POST",
    path: () => "/accounts/manual",
    body: () => ({ type: "nonsense", title: "Щось", currency_code: 840, balance: 10000,
      role: "brokerage", credit_limit: -5, ai_note: "  замітка  " }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: an investment account keeps its role and credit limit",
    method: "POST",
    path: () => "/accounts/manual",
    body: () => ({ type: "crypto", title: "Гаманець", currency_code: 840, balance: 100000,
      role: "investment", credit_limit: 50000 }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: changing a manual balance records a new snapshot",
    method: "PATCH",
    path: () => "/accounts/manual/acc-jar",
    body: () => ({ balance: 350000 }),
    extraProbes: ["accounts", "account_balance_history"],
  },
  {
    // A rename is not a balance event, so it must NOT add a history point — otherwise the chart
    // grows a step wherever the user tidied up a title.
    name: "accounts: renaming a manual one does not touch the history",
    method: "PATCH",
    path: () => "/accounts/manual/acc-jar",
    body: () => ({ title: "Банка на авто" }),
    extraProbes: ["accounts", "account_balance_history"],
  },
  {
    // `is_manual = 1` is in the WHERE clause: a bank-synced balance is the bank's to state, and
    // letting the client set it would make the account disagree with the statement.
    name: "accounts: the manual patch does not touch a bank account",
    method: "PATCH",
    path: () => "/accounts/manual/acc-uah",
    body: () => ({ balance: 999999 }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: manual patch with no fields is a no-op",
    method: "PATCH",
    path: () => "/accounts/manual/acc-jar",
    body: () => ({}),
    extraProbes: ["accounts", "account_balance_history"],
  },
  {
    name: "accounts: rename any account by title",
    method: "PATCH",
    path: () => "/accounts/:id/title".replace(":id", "acc-uah"),
    body: () => ({ title: "  Основна картка  " }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: rename rejected — blank title",
    method: "PATCH",
    path: () => "/accounts/acc-uah/title",
    body: () => ({ title: "   " }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: meta sets role, note and credit-card days",
    method: "PATCH",
    path: () => "/accounts/acc-cred/meta",
    body: () => ({ role: "investment", ai_note: "  кредитка  ", statement_day: 5, payment_day: 25, min_payment: 20000 }),
    extraProbes: ["accounts"],
  },
  {
    // Out-of-range days clear the condition rather than storing nonsense: a payment reminder on
    // "day 40" would never fire, and would look configured while being dead.
    name: "accounts: meta clears out-of-range days and non-positive minimums",
    method: "PATCH",
    path: () => "/accounts/acc-cred/meta",
    body: () => ({ statement_day: 40, payment_day: 0, min_payment: 0, ai_note: "   " }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: meta with no fields is a no-op",
    method: "PATCH",
    path: () => "/accounts/acc-cred/meta",
    body: () => ({}),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: archiving hides an account without touching its history",
    method: "PATCH",
    path: () => "/accounts/acc-jar/active",
    body: () => ({ active: false }),
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: delete rejected — a bank account can only be archived",
    method: "DELETE",
    path: () => "/accounts/acc-uah",
    extraProbes: ["accounts"],
  },
  {
    // The guard that matters: deleting an account with spending on it would orphan those rows,
    // and they are what every statistic is computed from.
    name: "accounts: delete rejected — the account still has transactions",
    method: "DELETE",
    path: () => "/accounts/acc-empty-manual",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit,
        is_manual, is_active, updated_at, role) VALUES ('acc-empty-manual','cash','Порожній',980,0,0,1,1,0,'liquid')`).run();
      db.raw.prepare(`INSERT INTO transactions (id, account_id, source, currency_code, time, amount, merchant)
        VALUES ('t-empty','acc-empty-manual','manual',980,1,-100,'Тест')`).run();
    },
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: delete an empty manual account",
    method: "DELETE",
    path: () => "/accounts/acc-empty-manual",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit,
        is_manual, is_active, updated_at, role) VALUES ('acc-empty-manual','cash','Порожній',980,0,0,1,1,0,'liquid')`).run();
    },
    extraProbes: ["accounts"],
  },
  {
    name: "accounts: delete rejected — unknown id",
    method: "DELETE",
    path: () => "/accounts/no-such-account",
    extraProbes: ["accounts"],
  },

  // ---- knowledge corpus ----------------------------------------------------------------------
  {
    name: "knowledge: create a user note",
    method: "POST",
    path: () => "/knowledge",
    body: () => ({ title: "  Мої правила  ", summary: "коротко", body: "  Не купую каву на виніс.  " }),
    extraProbes: ["knowledge_docs"],
  },
  {
    name: "knowledge: create rejected — no title",
    method: "POST",
    path: () => "/knowledge",
    body: () => ({ title: "  ", body: "текст" }),
    extraProbes: ["knowledge_docs"],
  },
  {
    name: "knowledge: create rejected — empty body",
    method: "POST",
    path: () => "/knowledge",
    body: () => ({ title: "Назва", body: "   " }),
    extraProbes: ["knowledge_docs"],
  },
  {
    // Editing a BUILT-IN doc stores an override row rather than mutating the shipped corpus,
    // so the factory text stays recoverable by deleting the override.
    name: "knowledge: editing a built-in doc stores an override",
    method: "PUT",
    path: () => "/knowledge/investing",
    body: () => ({ body: "Мій варіант тексту." }),
    extraProbes: ["knowledge_docs"],
  },
  {
    // `app-methodology` describes the CANON the numbers are computed by. Letting it be rewritten
    // would have the model explain figures differently from how the code produces them — the
    // one divergence in this project that argues with itself out loud.
    name: "knowledge: the methodology doc cannot be edited",
    method: "PUT",
    path: () => "/knowledge/app-methodology",
    body: () => ({ body: "Витрати рахуються інакше." }),
    extraProbes: ["knowledge_docs"],
  },
  {
    name: "knowledge: the methodology doc cannot be hidden",
    method: "DELETE",
    path: () => "/knowledge/app-methodology",
    extraProbes: ["knowledge_docs"],
  },
  {
    name: "knowledge: editing an unknown id is 404",
    method: "PUT",
    path: () => "/knowledge/no-such-doc",
    body: () => ({ body: "текст" }),
    extraProbes: ["knowledge_docs"],
  },
  {
    name: "knowledge: delete removes the row",
    method: "DELETE",
    path: () => "/knowledge/user:1",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO knowledge_docs (id, kind, title, summary, body, enabled, created_at, updated_at)
        VALUES ('user:1','user','Нотатка','','текст',1,0,0)`).run();
    },
    extraProbes: ["knowledge_docs"],
  },

  // ---- export --------------------------------------------------------------------------------
  {
    // Only the meta block is snapshotted — see `reduceBody`. What it pins is the row COUNT per
    // table, which is what proves the dump enumerates tables from the schema (and that
    // `user_secrets` stays out of a file that lands on the user's disk).
    name: "export: the full backup lists every table from the schema",
    method: "GET",
    path: () => "/export/all.json",
    setup: seedPlanning,
    reduceBody: (b) => (b as { meta: unknown }).meta,
  },
  {
    name: "export: transactions as CSV",
    method: "GET",
    path: () => "/export/transactions.csv?from=1778000000",
    raw: true,
  },
  // §CHAT-SYNC — conversations moved from `localStorage` into the user's own database, so the
  // write paths that used to be `JSON.stringify` into a browser now need the same guard as any
  // other write. Each of these covers a case that was free when the data lived on one device and
  // is not free now: the first message having to CREATE the row it appends to, regenerate having
  // to forget the old answer on the server too (otherwise the other device syncs it back as if it
  // were current), deletion taking the turns with it, and the one-time import running twice.
  {
    name: "chats: the first message creates the conversation and names it",
    method: "POST",
    path: () => "/chats/cnew1/messages",
    body: () => ({ content: "Скільки я витратив на таксі?", title: "Скільки я витратив на таксі?" }),
    extraProbes: ["chats"],
  },
  {
    name: "chats: regenerate drops the answer on the server, not only on screen",
    method: "POST",
    path: () => "/chats/cold1/truncate",
    body: () => ({ keep: 1 }),
    setup: (db) => {
      db.raw.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('cold1', 'Оренда', 1778700000, 1778700000)").run();
      db.raw.prepare(`INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES
        ('cold1', 'user', 'Скільки коштує оренда?', 1778700000),
        ('cold1', 'assistant', 'Перша відповідь', 1778700001),
        ('cold1', 'user', 'А підписки?', 1778700002)`).run();
    },
    extraProbes: ["chats"],
  },
  {
    name: "chats: deleting a conversation takes its messages with it",
    method: "DELETE",
    path: () => "/chats/cdel1",
    setup: (db) => {
      db.raw.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('cdel1', 'Зайва', 1778700000, 1778700000)").run();
      db.raw.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ('cdel1', 'user', 'Питання', 1778700000)").run();
    },
    extraProbes: ["chats"],
  },
  {
    name: "chats: importing the same conversation twice adds nothing",
    method: "POST",
    path: () => "/chats/import",
    body: () => ({
      chats: [
        { id: "cimp1", title: "Вже тут", updated_at: 1778700000000, messages: [{ role: "user", content: "Друга спроба" }] },
        { id: "cimp2", title: "Ще ні", updated_at: 1778700000000, messages: [{ role: "user", content: "Нова" }, { role: "assistant", content: "Відповідь" }] },
      ],
    }),
    setup: (db) => {
      db.raw.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('cimp1', 'Вже тут', 1778600000, 1778600000)").run();
      db.raw.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ('cimp1', 'user', 'Перша спроба', 1778600000)").run();
    },
    extraProbes: ["chats"],
  },
  // §A1 — facts, the USER's half of the one writer. The other half (the model filing a fact from
  // a conversation) is not an endpoint, so it is tested below against `runFinanceTool` directly.
  // Both go through `addFact`, and these pin the defaults that differ between them.
  {
    name: "facts: a fact the user typed is confirmed on arrival",
    method: "POST",
    path: () => "/facts",
    body: () => ({ text: "Комуналка подорожчала на 2500 ₴/міс", category_id: 7, adjust_kind: "delta_minor", adjust_value: 250000, confirm: true }),
    extraProbes: ["facts"],
  },
  {
    // The gate the other way round: a fact about the world at large ("I left my job") is narrative
    // only. Keeping the adjustment would attach a number to a category nobody named.
    name: "facts: a global fact drops the adjustment it came with",
    method: "POST",
    path: () => "/facts",
    body: () => ({ text: "Звільнився з роботи", adjust_kind: "multiplier", adjust_value: 0.5, confirm: true }),
    extraProbes: ["facts"],
  },
  // ---- §AI-AUDIT: what the model changed, and putting it back ------------------------------
  {
    // The invariant worth the test: revert restores the OLD value on the TRANSACTION and marks the
    // log row — it does not delete it. "The AI did this and I undid it" has to stay knowable.
    name: "ai-audit: reverting restores the previous category and marks the entry",
    method: "POST",
    path: () => "/ai-changes/9001/revert",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO ai_changes (id, tx_id, field, old_value, new_value, source, created_at)
                      VALUES (9001, 'tx0001', 'category_id', '2', '6', 'chat', 1778600000)`).run();
      db.raw.prepare("UPDATE transactions SET category_id = 6 WHERE id = 'tx0001'").run();
    },
    extraProbes: ["ai_changes"],
  },
  {
    // A second revert would write a stale value over whatever the person has since chosen: the log
    // records what WAS, not what is.
    name: "ai-audit: reverting twice is a no-op",
    method: "POST",
    path: () => "/ai-changes/9002/revert",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO ai_changes (id, tx_id, field, old_value, new_value, source, created_at, reverted_at)
                      VALUES (9002, 'tx0001', 'category_id', '2', '6', 'chat', 1778600000, 1778600100)`).run();
      db.raw.prepare("UPDATE transactions SET category_id = 11 WHERE id = 'tx0001'").run();
    },
    extraProbes: ["ai_changes"],
  },
  {
    // NULL in `old_value` is a real previous value — "had no category" — not a missing one.
    name: "ai-audit: reverting to no category at all",
    method: "POST",
    path: () => "/ai-changes/9003/revert",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO ai_changes (id, tx_id, field, old_value, new_value, source, created_at)
                      VALUES (9003, 'tx0001', 'category_id', NULL, '6', 'enrich', 1778600000)`).run();
      db.raw.prepare("UPDATE transactions SET category_id = 6 WHERE id = 'tx0001'").run();
    },
    extraProbes: ["ai_changes"],
  },
  {
    /**
     * The door the «reverting twice» rule left open, closed 2026-08-21.
     *
     * The model files it as 6, the person then corrects it to 11 BY HAND, and only afterwards
     * presses Повернути in the journal. Restoring `old_value` would put back 2 — a category from
     * before either of them — and silently discard the correction. The reasoning was already
     * written down one branch away, for a second revert; it is the same fact about any later
     * change, and the ordinary case is the one that costs someone their own work.
     */
    name: "ai-audit: revert REFUSES when the field has changed hands since",
    method: "POST",
    path: () => "/ai-changes/9004/revert",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO ai_changes (id, tx_id, field, old_value, new_value, source, created_at)
                      VALUES (9004, 'tx0001', 'category_id', '2', '6', 'enrich', 1778600000)`).run();
      // The human's later choice — not 6, and not 2 either.
      db.raw.prepare("UPDATE transactions SET category_id = 11 WHERE id = 'tx0001'").run();
    },
    extraProbes: ["ai_changes"],
  },
  {
    name: "ai-audit: reverting an unknown entry is 404, not a silent success",
    method: "POST",
    path: () => "/ai-changes/9999/revert",
    extraProbes: ["ai_changes"],
  },

  // ---- §TX-CHAT: a conversation about one operation is STORED --------------------------------
  // It used to live in React state and vanish on navigation. These pin the two properties that
  // make storing it useful rather than merely true: it is addressable by the transaction, and it
  // stays OUT of the advisor's conversation list.
  {
    name: "tx-chat: history is empty before anything was said",
    method: "GET",
    path: (db) => `/transactions/${txId(db, "Кафе")}/chat`,
    extraProbes: ["chats"],
  },
  {
    name: "tx-chat: a stored exchange does not appear in the advisor rail",
    method: "GET",
    path: () => "/chats",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO chats (id, title, created_at, updated_at, kind, entity_id)
                      VALUES ('tx-tx0001', 'це було за курс', 1778600000, 1778600000, 'tx', 'tx0001')`).run();
      db.raw.prepare(`INSERT INTO chats (id, title, created_at, updated_at)
                      VALUES ('cadv1', 'Скільки я витрачаю', 1778600001, 1778600001)`).run();
      db.raw.prepare(`INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES
        ('tx-tx0001', 'user', 'це було за курс, не розваги', 1778600000),
        ('tx-tx0001', 'assistant', 'Зрозумів, перекатегоризував.', 1778600001)`).run();
    },
    extraProbes: ["chats"],
  },
  {
    name: "tx-chat: the history reads back what was said about that operation",
    method: "GET",
    path: () => "/transactions/tx0001/chat",
    setup: (db) => {
      db.raw.prepare(`INSERT INTO chats (id, title, created_at, updated_at, kind, entity_id)
                      VALUES ('tx-tx0001', 'це було за курс', 1778600000, 1778600000, 'tx', 'tx0001')`).run();
      db.raw.prepare(`INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES
        ('tx-tx0001', 'user', 'це було за курс, не розваги', 1778600000),
        ('tx-tx0001', 'assistant', 'Зрозумів, перекатегоризував.', 1778600001)`).run();
    },
  },

  // ---- rules: the deterministic categorisation layer, finally writable ----------------------
  // The table existed from migration 0001 with no way to write to it but a seed. These pin the
  // guards that make user-authored rules safe: the shape checks (a one-character pattern would
  // file the whole history into one category), the §FK-GUARD on the category, and — the one that
  // matters — that applying a rule NEVER overwrites a category something else already decided.
  {
    name: "rules: a text rule is created with its category and priority",
    method: "POST",
    path: () => "/rules",
    body: () => ({ match_type: "text", pattern: "таксі", category_id: 3, priority: 50 }),
    extraProbes: ["rules"],
  },
  {
    // THE regression this exists for (found 2026-08-12, the day the feature shipped): the preview
    // used to search the CURRENT merchant, which AI enrichment rewrites to a clean name, while the
    // engine searches the bank's raw description. Here the row shows "Silpo" and the bank sent
    // "SILPO 1234 KYIV" — a rule on the raw text must be reported as matching, because that is
    // what will actually fire on the next one.
    name: "rules: the preview searches the RAW bank text, not the cleaned merchant",
    method: "POST",
    path: () => "/rules/preview",
    body: () => ({ match_type: "text", pattern: "SILPO 1234" }),
    setup: (db) => {
      db.raw.prepare(`INSERT INTO transactions (id, account_id, source, currency_code, time, amount, merchant, raw_json, category_id)
                      VALUES ('rule-raw', 'acc-uah', 'mono', 980, 1778600000, -20000, 'Silpo',
                              '{"description":"SILPO 1234 KYIV"}', NULL)`).run();
    },
  },
  {
    // The other half of the same mirror: a P2P transfer's description is just a name, and the
    // meaning is in the comment. Matching it was impossible until the engine started reading it.
    name: "rules: the preview matches a P2P comment, because the engine now does too",
    method: "POST",
    path: () => "/rules/preview",
    body: () => ({ match_type: "text", pattern: "оренда" }),
    setup: (db) => {
      db.raw.prepare(`INSERT INTO transactions (id, account_id, source, currency_code, time, amount, merchant, comment, category_id)
                      VALUES ('rule-p2p', 'acc-uah', 'mono', 980, 1778600000, -1200000, 'Іван П.', 'оренда за серпень', NULL)`).run();
    },
  },
  {
    name: "rules: rejected — a one-character pattern would match everything",
    method: "POST",
    path: () => "/rules",
    body: () => ({ match_type: "text", pattern: "а", category_id: 3 }),
    extraProbes: ["rules"],
  },
  {
    name: "rules: rejected — an MCC pattern must be digits",
    method: "POST",
    path: () => "/rules",
    body: () => ({ match_type: "mcc", pattern: "grocery", category_id: 1 }),
    extraProbes: ["rules"],
  },
  {
    name: "rules: rejected — the category must exist (§FK-GUARD)",
    method: "POST",
    path: () => "/rules",
    body: () => ({ match_type: "text", pattern: "щось", category_id: 9999 }),
    extraProbes: ["rules"],
  },
  {
    // Proves BOTH halves at once, which is the whole point: the fixture's "Ашан" already carries
    // category 1, and `rule-unc` carries none. After the apply the second must be filed and the
    // first must be untouched — a rule is a guess about text, and a stored category is a decision.
    name: "rules: applying one files ONLY the operations with no category",
    method: "POST",
    path: () => "/rules/7001/apply",
    setup: (db) => {
      db.raw.prepare("INSERT INTO rules (id, match_type, pattern, category_id, priority) VALUES (7001, 'text', 'Ашан', 6, 50)").run();
      db.raw.prepare(`INSERT INTO transactions (id, account_id, source, currency_code, time, amount, merchant, category_id)
                      VALUES ('rule-unc', 'acc-uah', 'mono', 980, 1778600000, -50000, 'Ашан Сільпо', NULL)`).run();
    },
    extraProbes: ["rules"],
  },
  {
    name: "rules: deleting one leaves the transactions it filed alone",
    method: "DELETE",
    path: (db) => {
      db.raw.prepare("INSERT INTO rules (id, match_type, pattern, category_id, priority) VALUES (7002, 'text', 'Кафе', 2, 50)").run();
      return "/rules/7002";
    },
    extraProbes: ["rules"],
  },
  {
    name: "export: transactions as strict RFC CSV",
    method: "GET",
    path: () => "/export/transactions.csv?from=1778000000&dialect=rfc",
    raw: true,
  },
];

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

test("golden: write endpoints leave the same database state", async (t) => {
  const restoreTime = freezeTime(FROZEN_NOW_ISO);
  const restoreUuid = freezeUuid();
  const restoreRandom = freezeRandom();
  try {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

    for (const sc of SCENARIOS) {
      await t.test(sc.name, async () => {
        // A FRESH database per scenario — unlike the read suite, these mutate, and a shared
        // fixture would make each case depend on the order of the ones before it.
        const db = migratedDb();
        seed(db);
        sc.setup?.(db);
        const env = testEnv(db);

        const init: RequestInit = { method: sc.method };
        // GET and DELETE carry no body here; sending one would be a request shape the client
        // never produces, and `fetch` rejects a body on GET outright.
        if (!sc.noBody && sc.method !== "GET" && sc.method !== "DELETE") {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(sc.body ? sc.body(db) : {});
        }

        const res = await api.request(sc.path(db), init, env);
        const text = await res.text();
        const state: Record<string, unknown> = probe(db);
        for (const key of sc.extraProbes ?? []) state[key] = EXTRA_PROBES[key](db);
        let body: unknown = sc.raw ? text : text ? JSON.parse(text) : null;
        if (sc.reduceBody) body = sc.reduceBody(body);
        const actual = JSON.stringify({ status: res.status, body, db: state }, null, 2);

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
    restoreRandom();
    restoreUuid();
    restoreTime();
  }
});

/**
 * §A1 — the OTHER half of the single fact writer: the model filing a fact from a conversation.
 *
 * Not in the scenario table because `remember_fact` is a tool, not an endpoint — it is reached
 * through `runToolConversation`, never through a URL. It still writes to the user's database, so
 * it needs the same guard as any write, and it needed one BEFORE the two `INSERT`s were merged
 * into `addFact`: this path is the one whose defaults may not drift. A model-authored fact that
 * arrived confirmed would move burn and runway on a guess, and nothing on screen would say so.
 *
 * Asserted rather than snapshotted: there are three columns that matter and each carries a
 * sentence of reasoning, which a golden file would reduce to a diff nobody reads.
 */
test("§A1: a fact the model files is stored as an unconfirmed proposal", async (t) => {
  const restoreTime = freezeTime(FROZEN_NOW_ISO);
  try {
    const { runFinanceTool } = await import("../lib/ai/chat-tools.ts");

    await t.test("with a category and an adjustment", async () => {
      const db = migratedDb();
      seed(db);
      const out = await runFinanceTool(testEnv(db) as never, "remember_fact", {
        text: "Метро подорожчало з 8 до 30 ₴", category: "Транспорт", multiplier: 3.75,
      }) as { saved?: boolean; needs_confirmation?: boolean };

      assert.equal(out.saved, true);
      // The model is told to say this out loud; if the flag ever went false the answer would
      // promise an effect the numbers are not going to show.
      assert.equal(out.needs_confirmation, true);

      const f = rows(db, "SELECT text, category_id, adjust_kind, adjust_value, confirmed_at, source FROM facts");
      assert.equal(f.length, 1);
      assert.equal(f[0]!.source, "ai_proposed");
      // THE GATE. `applyFactAdjustments` reads confirmed facts only, so this NULL is the whole
      // reason a model may file a fact at all.
      assert.equal(f[0]!.confirmed_at, null);
      assert.equal(f[0]!.adjust_kind, "multiplier");
      assert.equal(f[0]!.adjust_value, 3.75);
      assert.equal(f[0]!.category_id, 3);
    });

    await t.test("a global fact carries no adjustment", async () => {
      const db = migratedDb();
      seed(db);
      // No category, so the multiplier has nothing to apply to. Storing it anyway would leave a
      // number waiting for a category to be attached later — and then it would apply silently.
      await runFinanceTool(testEnv(db) as never, "remember_fact", {
        text: "Звільнився з роботи", multiplier: 0.5,
      });
      const f = rows(db, "SELECT category_id, adjust_kind, adjust_value, confirmed_at, source FROM facts");
      assert.equal(f.length, 1);
      assert.deepEqual(
        { cat: f[0]!.category_id, kind: f[0]!.adjust_kind, val: f[0]!.adjust_value, conf: f[0]!.confirmed_at },
        { cat: null, kind: null, val: null, conf: null },
      );
      assert.equal(f[0]!.source, "ai_proposed");
    });

    await t.test("an unknown category writes nothing at all", async () => {
      const db = migratedDb();
      seed(db);
      const out = await runFinanceTool(testEnv(db) as never, "remember_fact", {
        text: "Абонемент подорожчав", category: "Спортзал", monthly_delta_uah: 300,
      }) as { error?: string; needs_category?: boolean };

      // The tool RETURNS the error instead of throwing: the model has to be able to recover by
      // calling `list_categories` and retrying, and a thrown error would end the conversation.
      assert.match(out.error ?? "", /was not found/);
      assert.equal(out.needs_category, true);
      // And the fact must not land half-stored under a null category — the text alone would read
      // as a confirmed global fact about the world.
      assert.equal(rows(db, "SELECT id FROM facts").length, 0);
    });

    await t.test("empty text is refused before anything is written", async () => {
      const db = migratedDb();
      seed(db);
      const out = await runFinanceTool(testEnv(db) as never, "remember_fact", { text: "   " }) as { error?: string };
      assert.ok(out.error);
      assert.equal(rows(db, "SELECT id FROM facts").length, 0);
    });
  } finally {
    restoreTime();
  }
});
