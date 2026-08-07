// Transaction reads. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import { stLit } from "../lib/platform/i18n.ts";
import { STATS_JOINS, SPEND_WHERE, amountSum } from "../lib/finance/stats.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
// Contract types, imported rather than re-declared — a private twin of a response row is D2 one
// layer down: two spellings, drifting quietly, with `tsc` unable to compare them.
import type { TxRow, TxDetail, TagRow, ReceiptRow, ReceiptItemRow, TxSplit } from "../../shared/api/transactions.ts";
import type { SearchResults } from "../../shared/api/platform.ts";
import type { Transaction } from "../../shared/types.ts";

/**
 * What `byId` selects: the whole `transactions` row plus the joined labels.
 *
 * It is `TxDetail` minus the two things the ROUTE attaches afterwards — the receipt (a second
 * query plus its items) and the tags (a join table). Saying so with `Omit` rather than by hand
 * means adding a column to `TxDetail` cannot leave this row silently behind.
 */
export type TxDetailRow = Omit<TxDetail, "receipt" | "tags">;

/**
 * Feed filter, already parsed and coerced by the route.
 *
 * The route owns parsing (`?amin=` is a string in ₴ and arrives from the client); the repo owns
 * the query. Splitting it here means the WHERE-clause builder below is the only place that knows
 * how a filter becomes SQL — previously it was inline in the handler, so nothing else could
 * reuse it and the next feature would have written its own.
 */
export interface FeedFilter {
  limit: number;
  offset: number;
  category?: number;
  /** Roll up into this parent, i.e. include its sub-categories. */
  catparent?: number;
  account?: string;
  type?: "expense" | "income";
  from?: number;
  to?: number;
  /** Free text over merchant / comment / note / event name. */
  q?: string;
  /** Amount bounds in MINOR units, compared on absolute value. */
  aminMinor?: number;
  amaxMinor?: number;
}

function buildWhere(f: FeedFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  // §R5: a detected transfer shows as ONE row — hide the incoming (+) leg of the pair.
  where.push("NOT (t.transfer_pair_id IS NOT NULL AND t.amount > 0)");
  if (f.category !== undefined) { where.push("t.category_id = ?"); binds.push(f.category); }
  if (f.catparent !== undefined) { where.push("COALESCE(c.parent_id, t.category_id) = ?"); binds.push(f.catparent); }
  if (f.type === "expense") where.push("t.amount < 0");
  if (f.type === "income") where.push("t.amount > 0");
  if (f.account !== undefined) { where.push("t.account_id = ?"); binds.push(f.account); }
  if (f.from !== undefined) { where.push("t.time >= ?"); binds.push(f.from); }
  if (f.to !== undefined) { where.push("t.time <= ?"); binds.push(f.to); }
  // Compared on absolute value. Currencies are NOT converted — the filter is on the account's
  // own denomination, which is what the amount in the row means.
  if (f.aminMinor !== undefined) { where.push("ABS(t.amount) >= ?"); binds.push(f.aminMinor); }
  if (f.amaxMinor !== undefined) { where.push("ABS(t.amount) <= ?"); binds.push(f.amaxMinor); }
  if (f.q !== undefined) {
    where.push("(t.merchant LIKE ? OR t.comment LIKE ? OR t.user_note LIKE ? OR e.name LIKE ?)");
    binds.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/**
 * The columns of `transactions` the FEED sends. Exactly the `t.*` half of `TxRow` — the joined
 * display columns are added by the query below.
 *
 * **Why this list exists instead of `t.*`.** The feed used to send all 31 columns while `TxRow`
 * declares 21 of them, so a quarter of the response was fields only the detail screen reads:
 * `raw_json` above all, which on a real monobank operation is the bank's entire payload, shipped
 * on every row of a list that never shows it (measured: 24% of the response on the test fixture,
 * more in production). The type could not catch this — `satisfies` proves every declared field is
 * PRESENT, not that nothing else is, because the excess-property check only fires for object
 * literals and this is a row spread out of the database.
 *
 * So: adding a column to the table no longer widens this response by itself. A field that the
 * list genuinely needs is added here AND to `TxRow`, together.
 */
const FEED_COLUMNS = [
  "id", "account_id", "source", "time", "amount", "currency_code",
  "original_amount", "original_currency", "mcc", "category_id", "merchant",
  "comment", "user_note", "hold", "is_transfer", "real_category_id",
  "transfer_pair_id", "planned_id", "event_id", "importance", "reimbursed",
].map((c) => `t.${c}`).join(", ");

/**
 * The transaction feed, newest first, with the display joins the list needs.
 *
 * The self-join on `transfer_pair_id` resolves the other leg of a transfer into a
 * "from → to" label. It joins nothing when `transfer_pair_id` is NULL (NULL = NULL is false in
 * SQL), so ordinary transactions are unaffected by it.
 */
export async function listFeed(
  db: AppDb,
  locale: NotifLocale,
  filter: FeedFilter,
): Promise<TxRow[]> {
  const { clause, binds } = buildWhere(filter);
  const r = await db.prepare(
    `SELECT ${FEED_COLUMNS}, ${catNameSql(locale, "c.name")} AS category_name, c.color AS category_color, c.icon AS category_icon,
            a.title AS account_title, e.name AS event_name, e.color AS event_color,
            ap.title AS pair_account_title
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     LEFT JOIN transactions tp ON tp.transfer_pair_id = t.transfer_pair_id AND tp.id <> t.id
     LEFT JOIN accounts ap ON ap.id = tp.account_id
     ${clause}
     ORDER BY t.time DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, filter.limit, filter.offset)
    .all<TxRow>();
  return r.results ?? [];
}

// ---- one transaction ---------------------------------------------------------

/**
 * A single transaction with every display join the detail screen needs, including the other leg
 * of a transfer pair resolved into an account title.
 *
 * Returns the row untyped on purpose: it is `SELECT t.*`, so naming the columns here would be a
 * second, silently drifting copy of the table's shape. Phase 2 replaces this with a shared type.
 */
export async function byId(
  db: AppDb, locale: NotifLocale, id: string,
): Promise<TxDetailRow | null> {
  return await db.prepare(
    `SELECT t.*, ${catNameSql(locale, "c.name")} AS category_name, c.color AS category_color, c.icon AS category_icon,
            ${catNameSql(locale, "rc.name")} AS real_category_name, rc.color AS real_category_color,
            a.title AS account_title, a.type AS account_type,
            e.name AS event_name, e.color AS event_color,
            p.title AS planned_title,
            ap.title AS pair_account_title
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories rc ON rc.id = t.real_category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     LEFT JOIN planned_payments p ON p.id = t.planned_id
     LEFT JOIN transactions tp ON tp.transfer_pair_id = t.transfer_pair_id AND tp.id <> t.id
     LEFT JOIN accounts ap ON ap.id = tp.account_id
     WHERE t.id = ?`,
  ).bind(id).first<TxDetailRow>();
}

/** Tags attached to a transaction. Tags are rows in `categories`, reached through a join table. */
export async function tagsFor(
  db: AppDb, locale: NotifLocale, txId: string,
): Promise<TagRow[]> {
  const r = await db.prepare(
    `SELECT c.id, ${catNameSql(locale, "c.name")} AS name, c.color FROM transaction_tags tt JOIN categories c ON c.id = tt.category_id
     WHERE tt.transaction_id = ?`,
  ).bind(txId).all<TagRow>();
  return r.results ?? [];
}

/** The stored receipt row, WITHOUT its items — the caller assembles `ReceiptRow` from both. */
export type ReceiptHead = Omit<ReceiptRow, "items">;

export async function receiptById(db: AppDb, receiptId: number): Promise<ReceiptHead | null> {
  return await db.prepare("SELECT * FROM receipts WHERE id = ?").bind(receiptId).first<ReceiptHead>();
}

export async function receiptItems(db: AppDb, receiptId: number): Promise<ReceiptItemRow[]> {
  const r = await db.prepare("SELECT * FROM receipt_items WHERE receipt_id = ?").bind(receiptId).all<ReceiptItemRow>();
  return r.results ?? [];
}

export interface FrequentRow {
  merchant: string; category_id: number | null; currency_code: number; n: number; amounts: string;
}

/**
 * Repeat manual entries, for the quick-add suggestions.
 *
 * Only `source IN ('cash','manual')` — the point is to save retyping "кава 45", and a
 * bank-imported merchant is not something anyone re-enters by hand. `amounts` comes back as a
 * `GROUP_CONCAT` string because the caller takes the MEDIAN, which SQLite has no aggregate for.
 */
export async function frequentManual(db: AppDb, since: number): Promise<FrequentRow[]> {
  const r = await db.prepare(
    `SELECT t.merchant AS merchant, t.category_id AS category_id, t.currency_code AS currency_code,
            COUNT(*) AS n, GROUP_CONCAT(t.amount) AS amounts
       FROM transactions t
      WHERE t.source IN ('cash', 'manual') AND t.amount < 0 AND t.merchant IS NOT NULL AND t.merchant <> ''
        AND t.time >= ?
      GROUP BY LOWER(t.merchant), t.currency_code
     HAVING n >= 2
      ORDER BY n DESC, MAX(t.time) DESC
      LIMIT 8`,
  ).bind(since).all<FrequentRow>();
  return r.results ?? [];
}

/** Transactions still waiting for AI categorisation. Drives the "enrich pending" counter. */
export async function pendingEnrichCount(db: AppDb): Promise<number> {
  const r = await db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE source = 'mono' AND ai_enriched = 0 AND category_id IS NULL AND hold = 0",
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * The three fields that decide whether a freshly stored operation needs the AI.
 *
 * Read right after the write rather than inferred from what was written: the deterministic
 * categoriser may have matched an alias, a subscription or an MCC rule during the insert, and
 * calling a model for a row that already has a category is money spent to learn nothing.
 */
export async function enrichStatusOf(
  db: AppDb, id: string,
): Promise<{ category_id: number | null; ai_enriched: number; hold: number } | null> {
  return await db.prepare("SELECT category_id, ai_enriched, hold FROM transactions WHERE id = ?")
    .bind(id).first<{ category_id: number | null; ai_enriched: number; hold: number }>();
}

/**
 * How many of these ids are already stored — the CSV import's duplicate count.
 *
 * Chunked at 100 because the ids come from a file the user chose: a decade of statements is one
 * `IN (…)` list otherwise, and SQLite has a hard ceiling on bound parameters. The chunk size is
 * the query's business, which is why the loop lives here rather than in the handler.
 *
 * Counted BEFORE writing, deliberately: "imported 0 of 300" after the fact reads as a failure
 * when it is the correct answer for a statement that was already imported.
 */
export async function countExisting(db: AppDb, ids: string[]): Promise<number> {
  let found = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(...chunk).first<number>("n");
    found += Number(row ?? 0);
  }
  return found;
}

// ---- §SPLIT ------------------------------------------------------------------

/** The parts of a split transaction, with their category labels. */
export async function splitsFor(
  db: AppDb, locale: NotifLocale, txId: string,
): Promise<TxSplit[]> {
  const r = await db.prepare(
    `SELECT s.id, s.category_id, s.amount, ${catNameSql(locale, "cat.name")} AS category_name, cat.color AS category_color
     FROM tx_splits s LEFT JOIN categories cat ON cat.id = s.category_id
     WHERE s.tx_id = ? ORDER BY s.id`,
  ).bind(txId).all<TxSplit>();
  return r.results ?? [];
}

// ---- §COMPENSATION reads -----------------------------------------------------

export interface RbTx {
  id: string; label: string; account_title: string | null;
  amount: number; currency_code: number; time: number;
  /** How much of this incoming payment has not been handed out yet. */
  available: number;
  /** How much of it has already gone to THIS expense. */
  allocated_here: number;
}

/**
 * The projection shared by "already linked" and "candidates".
 *
 * The label is assembled SERVER-SIDE because incoming P2P rows often have an empty `merchant`,
 * and a candidate row rendered from date and amount alone is unreadable. Order of preference:
 * merchant → bank comment → user note → account title → a generic word, and that last resort is
 * a real phrase, so it follows the reader's locale.
 */
function rbSelect(locale: NotifLocale): string {
  const label = `COALESCE(NULLIF(TRIM(t.merchant), ''), NULLIF(TRIM(t.comment), ''), NULLIF(TRIM(t.user_note), ''), a.title, ${stLit(locale, "incoming")})`;
  return `
    SELECT t.id, ${label} AS label, a.title AS account_title, t.amount, t.currency_code, t.time,
           t.amount - COALESCE(t.reimburses_total, 0) AS available,
           COALESCE((SELECT r.amount FROM tx_reimbursements r WHERE r.source_tx_id = t.id AND r.expense_id = ?), 0) AS allocated_here
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id`;
}

/** The expense being compensated: just the columns the allocation maths needs. */
export async function reimbursementTarget(
  db: AppDb, id: string,
): Promise<{ id: string; amount: number; currency_code: number; time: number; reimbursed: number | null } | null> {
  return await db.prepare(
    "SELECT id, amount, currency_code, time, reimbursed FROM transactions WHERE id = ?",
  ).bind(id).first();
}

/** The incoming payment being spread: `reimburses_total` is how much of it is already handed out. */
export async function reimbursementSource(
  db: AppDb, id: string,
): Promise<{ id: string; amount: number; currency_code: number; reimburses_total: number | null } | null> {
  return await db.prepare(
    "SELECT id, amount, currency_code, reimburses_total FROM transactions WHERE id = ?",
  ).bind(id).first();
}

/** Incoming payments already allocated to this expense. */
export async function reimbursementsLinked(
  db: AppDb, locale: NotifLocale, expenseId: string,
): Promise<RbTx[]> {
  const r = await db.prepare(
    `${rbSelect(locale)} WHERE t.id IN (SELECT source_tx_id FROM tx_reimbursements WHERE expense_id = ?) ORDER BY t.time`,
  ).bind(expenseId, expenseId).all<RbTx>();
  return r.results ?? [];
}

/**
 * Plausible sources for compensating this expense: same currency, within ±21 days, and — the part
 * that matters — with a REMAINING free balance.
 *
 * Exhaustion is measured by `reimburses_total`, not by whether a link exists at all: one incoming
 * payment can cover several expenses ("they sent 2400 — 1870 for one thing, the rest for
 * another"), so "already used once" must not remove it from the list.
 */
export async function reimbursementCandidates(
  db: AppDb, locale: NotifLocale, expenseId: string,
  currencyCode: number, time: number, windowSec: number,
): Promise<RbTx[]> {
  const r = await db.prepare(
    `${rbSelect(locale)}
     WHERE t.amount > 0 AND t.transfer_pair_id IS NULL AND t.currency_code = ?
       AND t.time BETWEEN ? AND ?
       AND t.amount - COALESCE(t.reimburses_total, 0) > 0
       AND t.id NOT IN (SELECT source_tx_id FROM tx_reimbursements WHERE expense_id = ?)
     ORDER BY ABS(t.time - ?) LIMIT 12`,
  ).bind(expenseId, currencyCode, time - windowSec, time + windowSec, expenseId, time).all<RbTx>();
  return r.results ?? [];
}

export interface RbUsage {
  id: string; amount: number; label: string; time: number; expense_amount: number;
}

/** The reverse view: which expenses THIS incoming payment was spread across. */
export async function reimbursementUsage(
  db: AppDb, locale: NotifLocale, sourceId: string,
): Promise<RbUsage[]> {
  const r = await db.prepare(
    `SELECT e.id, r.amount,
            COALESCE(NULLIF(TRIM(e.merchant), ''), NULLIF(TRIM(e.comment), ''), ${stLit(locale, "expense")}) AS label,
            e.time, e.amount AS expense_amount
     FROM tx_reimbursements r JOIN transactions e ON e.id = r.expense_id
     WHERE r.source_tx_id = ? ORDER BY e.time`,
  ).bind(sourceId).all<RbUsage>();
  return r.results ?? [];
}

// ---- command-palette search --------------------------------------------------

export interface SearchHits {
  merchants: { name: string; n: number; spent: number }[];
  categories: { id: number; name: string; color: string | null; parent_name: string | null }[];
  transactions: SearchResults["transactions"];
}

/**
 * Command-palette search across merchants, categories and transactions.
 *
 * ⚠️ **`variants` is not redundant.** SQLite folds case for ASCII ONLY: `LOWER('Сільпо')` is still
 * `'Сільпо'` (verified on D1), so `LIKE '%сільпо%'` would NEVER match "Сільпо" — the app's main
 * language. The caller builds the case variants in JS, which is Unicode-aware, and they are
 * OR-matched here. Deliberately cheap: short LIMITs, because the palette fires this on every
 * keystroke.
 */
export async function search(
  db: AppDb, locale: NotifLocale, mult: string, variants: string[],
): Promise<SearchHits> {
  const likes = variants.map((v) => `%${v}%`);
  const orLike = (col: string) => `(${variants.map(() => `${col} LIKE ?`).join(" OR ")})`;

  const [merchants, categories, transactions] = await Promise.all([
    db.prepare(
      `SELECT t.merchant AS name, COUNT(DISTINCT t.id) AS n, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE ${orLike("t.merchant")} AND ${SPEND_WHERE}
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 6`,
    ).bind(...likes).all<{ name: string; n: number; spent: number }>(),
    db.prepare(
      `SELECT c.id, ${catNameSql(locale, "c.name")} AS name, c.color, ${catNameSql(locale, "p.name")} AS parent_name
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       WHERE ${orLike("c.name")} ORDER BY c.parent_id IS NOT NULL, c.name LIMIT 6`,
    ).bind(...likes).all<{ id: number; name: string; color: string | null; parent_name: string | null }>(),
    db.prepare(
      `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, ${catNameSql(locale, "c.name")} AS category_name
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${orLike("t.merchant")} OR ${orLike("t.comment")} OR ${orLike("t.user_note")}
       ORDER BY t.time DESC LIMIT 6`,
    ).bind(...likes, ...likes, ...likes).all<SearchResults["transactions"][number]>(),
  ]);
  return {
    merchants: merchants.results ?? [],
    categories: categories.results ?? [],
    transactions: transactions.results ?? [],
  };
}

// ==============================================================================================
// WRITES
//
// The division here is deliberate and is the reason phase 1 stops where it does: this layer owns
// the SQL TEXT, the handler still owns the TRANSACTION BOUNDARY. Several of these endpoints are
// scenarios rather than queries — they read, decide, then write a set of statements that must land
// together — and deciding where that boundary belongs is phase 3's job (`services/`), not a
// question to answer while moving strings. So the multi-statement operations below hand back
// STATEMENTS for the caller to `batch()`, instead of quietly choosing an ordering of their own.
// ==============================================================================================

/**
 * The whole stored row, for callers that must compare against what is ALREADY there.
 *
 * `Transaction` (shared/types.ts) is the table, not a response: no joined labels, no computed
 * columns. That is the point — the edit scenario decides whether the user renamed a merchant by
 * comparing with what the bank last wrote, and a joined display name would answer a different
 * question.
 */
export async function rawById(db: AppDb, id: string): Promise<Transaction | null> {
  return await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<Transaction>();
}

export async function amountOf(db: AppDb, id: string): Promise<{ amount: number } | null> {
  return await db.prepare("SELECT amount FROM transactions WHERE id = ?").bind(id).first<{ amount: number }>();
}

export async function amountAndCurrency(
  db: AppDb, id: string,
): Promise<{ amount: number; currency_code: number } | null> {
  return await db.prepare("SELECT amount, currency_code FROM transactions WHERE id = ?")
    .bind(id).first<{ amount: number; currency_code: number }>();
}

export async function reimbursedOf(db: AppDb, id: string): Promise<{ reimbursed: number | null } | null> {
  return await db.prepare("SELECT reimbursed FROM transactions WHERE id = ?")
    .bind(id).first<{ reimbursed: number | null }>();
}

export async function sourceAndRaw(
  db: AppDb, id: string,
): Promise<{ source: string; raw_json: string | null } | null> {
  return await db.prepare("SELECT source, raw_json FROM transactions WHERE id = ?")
    .bind(id).first<{ source: string; raw_json: string | null }>();
}

// ---- editing one transaction -------------------------------------------------

/**
 * Fields a PATCH may set. Only keys PRESENT are written, so `null` (clear) stays distinct from
 * absent (leave alone) — the distinction the whole partial-update contract rests on.
 */
export interface TxPatch {
  category_id?: number | null;
  merchant?: string;
  user_note?: string;
  is_transfer?: boolean;
  real_category_id?: number | null;
  event_id?: number | null;
  importance?: string | null;
  name_locked?: boolean;
}

export async function updateFields(db: AppDb, id: string, patch: TxPatch): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); binds.push(v); };
  if (patch.category_id !== undefined) put("category_id", patch.category_id);
  if (patch.merchant !== undefined) put("merchant", patch.merchant);
  if (patch.user_note !== undefined) put("user_note", patch.user_note);
  if (patch.is_transfer !== undefined) put("is_transfer", patch.is_transfer ? 1 : 0);
  if (patch.real_category_id !== undefined) put("real_category_id", patch.real_category_id);
  if (patch.event_id !== undefined) put("event_id", patch.event_id);
  if (patch.importance !== undefined) put("importance", patch.importance);
  if (patch.name_locked !== undefined) put("name_locked", patch.name_locked ? 1 : 0);
  if (!sets.length) return;
  await db.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
}

/**
 * §R2-TX4: a "real category" only means something inside bucket 13 ("Transfers and withdrawals"),
 * where it records what a withdrawal was ACTUALLY spent on. On an ordinary transaction it would
 * duplicate the main category and confuse the roll-up, so it is cleared.
 *
 * Runs unconditionally after an edit rather than being decided in JS: the check has to see the
 * category as it is AFTER the update, and a re-read to decide would race with nothing useful.
 */
export async function clearRealCategoryOutsideTransfers(db: AppDb, id: string): Promise<void> {
  await db.prepare(
    `UPDATE transactions SET real_category_id = NULL
     WHERE id = ? AND is_transfer = 0 AND real_category_id IS NOT NULL
       AND COALESCE(
             (SELECT COALESCE(cat.parent_id, cat.id) FROM categories cat WHERE cat.id = transactions.category_id),
             -1
           ) != 13`,
  ).bind(id).run();
}

export async function clearTags(db: AppDb, txId: string): Promise<void> {
  await db.prepare("DELETE FROM transaction_tags WHERE transaction_id = ?").bind(txId).run();
}

export async function addTag(db: AppDb, txId: string, categoryId: number): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, category_id) VALUES (?, ?)")
    .bind(txId, categoryId).run();
}

/** Statement form of `addTag`, for bulk tagging where the caller batches. */
export function addTagStmt(db: AppDb, txId: string, categoryId: number) {
  return db.prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, category_id) VALUES (?, ?)")
    .bind(txId, categoryId);
}

// ---- learned aliases (§6.3) --------------------------------------------------

export async function aliasRealCategory(
  db: AppDb, rawKey: string,
): Promise<{ real_category_id: number | null } | null> {
  return await db.prepare(
    "SELECT real_category_id FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(rawKey).first<{ real_category_id: number | null }>();
}

export async function deleteAlias(db: AppDb, rawKey: string): Promise<void> {
  await db.prepare("DELETE FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ?")
    .bind(rawKey).run();
}

/**
 * Store a hand-made rule. `source = 'manual'` is load-bearing: auto re-sweeps and the merchant
 * consensus must never overwrite what the user decided by hand (§Alias source).
 */
export async function insertManualAlias(
  db: AppDb, rawKey: string, displayName: string | null, categoryId: number | null,
  isTransfer: number, realCategoryId: number | null, now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, is_transfer, real_category_id, source, created_at)
     VALUES ('mono_desc', ?, ?, ?, ?, ?, 'manual', ?)`,
  ).bind(rawKey, displayName, categoryId, isTransfer, realCategoryId, now).run();
}

/** Apply a freshly learned rule to the mono transactions that already match its raw description. */
export async function backApplyAlias(
  db: AppDb, categoryId: number | null, merchant: string | null,
  isTransfer: number, realCategoryId: number | null, rawKey: string,
): Promise<void> {
  await db.prepare(
    `UPDATE transactions SET category_id = COALESCE(?, category_id), merchant = COALESCE(?, merchant),
                             is_transfer = ?, real_category_id = COALESCE(?, real_category_id)
     WHERE source = 'mono' AND json_extract(raw_json, '$.description') = ?`,
  ).bind(categoryId, merchant, isTransfer, realCategoryId, rawKey).run();
}

// ---- transfer review (§F2 step 2) --------------------------------------------

export async function setRealCategory(db: AppDb, id: string, categoryId: number | null): Promise<void> {
  await db.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?").bind(categoryId, id).run();
}

/** Returns how many alias rows were updated — zero means there is none yet and one must be created. */
export async function updateAliasRealCategory(
  db: AppDb, rawKey: string, categoryId: number | null,
): Promise<number> {
  const r = await db.prepare(
    "UPDATE merchant_aliases SET real_category_id = ? WHERE match_type = 'mono_desc' AND raw_key = ?",
  ).bind(categoryId, rawKey).run();
  return r.meta.changes ?? 0;
}

export async function insertAliasRealCategory(
  db: AppDb, rawKey: string, categoryId: number | null, now: number,
): Promise<void> {
  await db.prepare(
    "INSERT INTO merchant_aliases (match_type, raw_key, real_category_id, created_at) VALUES ('mono_desc', ?, ?, ?)",
  ).bind(rawKey, categoryId, now).run();
}

/** Spread a reviewed real-category onto matching rows that have NONE yet — never overwrite. */
export async function backfillRealCategory(
  db: AppDb, categoryId: number | null, rawKey: string,
): Promise<void> {
  await db.prepare(
    `UPDATE transactions SET real_category_id = ?
     WHERE source = 'mono' AND real_category_id IS NULL
       AND json_extract(raw_json, '$.description') = ?`,
  ).bind(categoryId, rawKey).run();
}

// ---- bulk edit ---------------------------------------------------------------

export interface BulkPatch {
  event_id?: number | null;
  category_id?: number | null;
  is_transfer?: boolean;
  importance?: string | null;
}

/**
 * Apply one patch to many transactions, plus optional tags.
 *
 * Chunked at 100 ids: the `IN (...)` list is expanded into placeholders, and an unbounded one
 * would hit the statement's variable limit on a large selection.
 *
 * Tags are ADDED, never replaced — a bulk "tag these" must not silently wipe tags put on
 * individual rows by hand. Removal lives on the transaction detail screen.
 */
export async function bulkApply(
  db: AppDb, ids: string[], patch: BulkPatch, tagIds: number[],
): Promise<number> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (patch.event_id !== undefined) put("event_id", patch.event_id);
  if (patch.category_id !== undefined) put("category_id", patch.category_id);
  if (patch.is_transfer !== undefined) put("is_transfer", patch.is_transfer ? 1 : 0);
  if (patch.importance !== undefined) put("importance", patch.importance);

  let updated = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => "?").join(",");
    if (sets.length) {
      const r = await db.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id IN (${ph})`)
        .bind(...vals, ...chunk).run();
      updated += r.meta.changes ?? 0;
    }
    if (tagIds.length) {
      await db.batch(chunk.flatMap((id) => tagIds.map((tag) => addTagStmt(db, id, tag))));
      if (!sets.length) updated += chunk.length;
    }
  }
  return updated;
}

// ---- manual transfer ---------------------------------------------------------

/**
 * Write both legs of a transfer as ONE batch.
 *
 * They share a `transfer_pair_id`, which is the canonical definition of "one movement between my
 * own accounts" — `is_transfer = 1` alone would NOT do it (five code paths set that flag and none
 * of them produces a pair), and the movement would surface as an expense plus an unexplained
 * income. Batched precisely because a half-written pair is worse than no transfer at all.
 */
export async function insertTransferPair(
  db: AppDb,
  legs: {
    id: string; account_id: string; time: number; amount: number; currency_code: number;
  }[],
  pairId: string, note: string | null, createdAt: number,
): Promise<void> {
  await db.batch(legs.map((l) => db.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, is_transfer, transfer_pair_id, user_note, created_at)
     VALUES (?, ?, 'manual', ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(l.id, l.account_id, l.time, l.amount, l.currency_code, pairId, note, createdAt)));
}

// ---- §SPLIT writes -----------------------------------------------------------

/** Replace every part of a split in one batch — an empty `parts` removes the split entirely. */
export async function replaceSplits(
  db: AppDb, txId: string, parts: { category_id: number; amount: number }[], now: number,
): Promise<void> {
  const stmts = [db.prepare("DELETE FROM tx_splits WHERE tx_id = ?").bind(txId)];
  for (const p of parts) {
    stmts.push(db.prepare(
      "INSERT INTO tx_splits (tx_id, category_id, amount, created_at) VALUES (?, ?, ?, ?)",
    ).bind(txId, p.category_id, p.amount, now));
  }
  await db.batch(stmts);
}

export async function hasSplits(db: AppDb, txId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM tx_splits WHERE tx_id = ? LIMIT 1").bind(txId).first());
}

// ---- §COMPENSATION writes ----------------------------------------------------

/**
 * Candidate sources with their spendable balance, as seen BY THIS EXPENSE.
 *
 * The `+ (what this expense already holds)` term is not a rounding nicety: without it, editing an
 * existing allocation would be blocked by its own reservation, so lowering an amount would be
 * impossible.
 */
export async function sourcesWithAvailable(
  db: AppDb, expenseId: string, sourceIds: string[],
): Promise<{ id: string; amount: number; currency_code: number; available: number }[]> {
  const r = await db.prepare(
    `SELECT t.id, t.amount, t.currency_code,
            t.amount - COALESCE(t.reimburses_total, 0)
              + COALESCE((SELECT r.amount FROM tx_reimbursements r WHERE r.source_tx_id = t.id AND r.expense_id = ?), 0) AS available
     FROM transactions t WHERE t.id IN (${sourceIds.map(() => "?").join(",")})`,
  ).bind(expenseId, ...sourceIds)
    .all<{ id: string; amount: number; currency_code: number; available: number }>();
  return r.results ?? [];
}

/** Sources currently allocated to this expense — they must be recalculated after a replacement. */
export async function allocationSources(db: AppDb, expenseId: string): Promise<string[]> {
  const r = await db.prepare("SELECT source_tx_id FROM tx_reimbursements WHERE expense_id = ?")
    .bind(expenseId).all<{ source_tx_id: string }>();
  return (r.results ?? []).map((x) => x.source_tx_id);
}

export function clearAllocationsStmt(db: AppDb, expenseId: string) {
  return db.prepare("DELETE FROM tx_reimbursements WHERE expense_id = ?").bind(expenseId);
}

export function insertAllocationStmt(
  db: AppDb, expenseId: string, sourceId: string, amount: number, now: number,
) {
  return db.prepare(
    "INSERT INTO tx_reimbursements (expense_id, source_tx_id, amount, created_at) VALUES (?, ?, ?, ?)",
  ).bind(expenseId, sourceId, amount, now);
}

/**
 * Recompute both denormalised sums from the allocation table.
 *
 * THE SINGLE WRITER of `reimbursed` and `reimburses_total`. The canon reads those two columns —
 * `EFF_AMOUNT` adds `reimbursed`, `EFF_INCOME` subtracts `reimburses_total` — so any other place
 * that set them would put the statistics out of step with `tx_reimbursements` without a single
 * failing query to show for it.
 */
export function recalcStmts(db: AppDb, ids: string[]) {
  return ids.map((txId) =>
    db.prepare(
      `UPDATE transactions SET
         reimbursed = COALESCE((SELECT SUM(r.amount) FROM tx_reimbursements r WHERE r.expense_id = ?), 0),
         reimburses_total = COALESCE((SELECT SUM(r.amount) FROM tx_reimbursements r WHERE r.source_tx_id = ?), 0)
       WHERE id = ?`,
    ).bind(txId, txId, txId),
  );
}

/** Manual compensation has no source row, so it is added on top after the recalculation. */
export function addManualReimbursedStmt(db: AppDb, expenseId: string, amount: number) {
  return db.prepare("UPDATE transactions SET reimbursed = reimbursed + ? WHERE id = ?")
    .bind(amount, expenseId);
}

/**
 * Rows for the CSV export (§J).
 *
 * The `+` leg of a detected pair is dropped, exactly as the transaction list drops it: a transfer
 * between your own accounts is ONE movement, and exporting both sides would make an accountant's
 * total count the money twice.
 *
 * `from` / `to` are optional and appended as bound predicates. The 20 000 ceiling is the file's,
 * not the query's — a spreadsheet stops being a spreadsheet well before that.
 */
export interface CsvRow {
  time: number;
  merchant: string | null;
  comment: string | null;
  user_note: string | null;
  amount: number;
  currency_code: number;
  is_transfer: number;
  category_name: string | null;
  account_title: string | null;
  event_name: string | null;
}

export async function forCsvExport(
  db: AppDb, locale: NotifLocale, from: number | null, to: number | null,
): Promise<CsvRow[]> {
  const where: string[] = ["NOT (t.transfer_pair_id IS NOT NULL AND t.amount > 0)"];
  const binds: unknown[] = [];
  if (from != null) { where.push("t.time >= ?"); binds.push(from); }
  if (to != null) { where.push("t.time <= ?"); binds.push(to); }
  const r = await db.prepare(
    `SELECT t.time, t.merchant, t.comment, t.user_note, t.amount, t.currency_code, t.is_transfer,
            ${catNameSql(locale, "c.name")} AS category_name, a.title AS account_title, e.name AS event_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     WHERE ${where.join(" AND ")}
     ORDER BY t.time DESC LIMIT 20000`,
  ).bind(...binds).all<CsvRow>();
  return r.results ?? [];
}
