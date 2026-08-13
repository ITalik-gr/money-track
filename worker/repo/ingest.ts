// The ONE writer of an incoming bank transaction (BANKS.md §5, step 1).
//
// Until now there were two, and a third was about to be written. `repo.upsertMonoTx` wrote rows
// arriving from monobank; `csv.importTransactions` wrote rows arriving from a file. They agreed on
// almost everything and differed in four places nobody had decided on purpose: whether a comment
// took part in categorisation, whether an obviously-internal description marked the row as a
// transfer, which columns were written at all, and what happens when the id is already there.
//
// That is the exact shape of §CUR-PLAN, §SUB-MONTH and §A1-WRITE: one concept, two implementations,
// drifting where nobody looks. With a second bank the drift stops being theoretical — a polled
// provider re-sends a row as its state changes, so it needs the settle-in-place behaviour that
// only the mono path had.
//
// So the differences that were real became ARGUMENTS, and the differences that were accidents
// were removed:
//   • `onConflict` — a FEED re-sends the same operation as it changes state and must overwrite;
//     a FILE re-import is a duplicate of something already stored, possibly hand-edited since,
//     and must not. This is a property of the delivery channel, not of the bank.
//   • `mintAccount` — a feed may legitimately mention an account we have never synced (§STUB-ACC);
//     a file cannot, because its account came from a dropdown, so an unknown id there is a bug
//     rather than news, and minting one would bury it.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { CanonicalTx } from "../lib/bank/providers/provider.ts";
import { categorize } from "../lib/finance/categorize.ts";
import { descriptionIsTransfer } from "../lib/finance/transfers.ts";

/** What to do when the id is already in the table. See the note above — this is the channel, not the bank. */
export type ConflictPolicy = "refresh" | "ignore";

export interface IngestOptions {
  /** `transactions.source`: 'mono' | 'import' | … — kept as the provider's own word for itself. */
  source: string;
  onConflict: ConflictPolicy;
}

/**
 * The account's currency, minting a STUB row when the feed names an account we have never synced.
 *
 * Lives here rather than inside `upsertCanonicalTx` because the caller needs the answer BEFORE it
 * can normalise: whether an operation carries `original_amount`/`original_currency` depends on
 * whether its own currency differs from the account's, and that decision belongs to the provider
 * (BANKS.md §6 — sign, currency and minor units normalise in exactly one place per provider).
 *
 * §STUB-ACC: `type`/`title` are deliberately left NULL for the next `syncAccounts` to fill in — a
 * real-looking made-up name would survive as data. The currency is the one honest guess available,
 * and it is the same value the transaction itself falls back to, so a row and its account cannot
 * disagree.
 */
export async function accountCurrencyForIngest(
  db: AppDb,
  accountId: string,
  feed: { currency_code: number; balance?: number | null },
): Promise<number> {
  const acc = await db
    .prepare("SELECT currency_code FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ currency_code: number | null }>();
  if (acc) return acc.currency_code ?? feed.currency_code;

  await db
    .prepare(
      `INSERT INTO accounts (id, currency_code, balance, credit_limit, is_manual, is_active, updated_at)
       VALUES (?, ?, ?, 0, 0, 1, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(accountId, feed.currency_code, feed.balance ?? 0, Math.floor(Date.now() / 1000))
    .run();
  return feed.currency_code;
}

/**
 * Writes one canonical transaction, running the deterministic categoriser on insert.
 *
 * `inserted: false` covers both "already there, left alone" and "already there, refreshed" — the
 * callers that count (the CSV import reports duplicates) only ever care whether a NEW row appeared.
 */
export async function upsertCanonicalTx(
  db: AppDb,
  tx: CanonicalTx,
  opts: IngestOptions,
): Promise<{ inserted: boolean }> {
  const existing = await db
    .prepare("SELECT id, amount, transfer_pair_id FROM transactions WHERE id = ?")
    .bind(tx.id)
    .first<{ id: string; amount: number; transfer_pair_id: string | null }>();

  if (existing) {
    if (opts.onConflict === "ignore") return { inserted: false };

    // A pair is matched on EQUAL opposite amounts, and holds are paired too. If the settlement
    // changed the amount the old pair is no longer equal, so BOTH sides are unpaired (they share
    // one `transfer_pair_id`) and the next `detectTransfers` rebuilds it. Without this the "+"
    // side would stay hidden in the list forever.
    if (existing.transfer_pair_id && existing.amount !== tx.amount) {
      await db
        .prepare("UPDATE transactions SET transfer_pair_id = NULL WHERE transfer_pair_id = ?")
        .bind(existing.transfer_pair_id)
        .run();
    }
    // Refresh the volatile fields (hold → settled, balance) and keep manual edits to
    // category/note: the feed is authoritative about what the bank did, never about what the
    // human decided afterwards.
    await db
      .prepare("UPDATE transactions SET amount=?, balance_after=?, hold=?, comment=?, raw_json=? WHERE id=?")
      .bind(
        tx.amount,
        tx.balance_after ?? null,
        tx.hold ? 1 : 0,
        tx.comment ?? null,
        tx.raw === undefined ? null : JSON.stringify(tx.raw),
        tx.id,
      )
      .run();
    return { inserted: false };
  }

  const { category_id, display_name, is_transfer, real_category_id, planned_id } = await categorize(db, {
    mcc: tx.mcc ?? null,
    description: tx.description ?? null,
    // §RULES-UI: the text a rule matches against is description + comment, in the engine and in
    // the preview alike. The importer used to pass only the description, which made it a third
    // opinion about the same haystack — and for a P2P row the description is just someone's name
    // while the meaning sits in the comment.
    comment: tx.comment ?? null,
    amount: tx.amount,
    currency_code: tx.currency_code,
  });

  // §Інваріанти lists insert-time description detection as one of the five paths that set
  // `is_transfer`. It was only ever applied to the webhook, so the same "Поповнення власного
  // рахунку" row counted as spending when it arrived in a file.
  const transfer = is_transfer || descriptionIsTransfer(tx.description ?? null) ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO transactions
        (id, account_id, source, time, amount, currency_code, original_amount, original_currency,
         mcc, category_id, real_category_id, planned_id, merchant,
         comment, balance_after, cashback, hold, is_transfer, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tx.id,
      tx.account_id,
      opts.source,
      tx.time,
      tx.amount,
      tx.currency_code,
      tx.original_amount ?? null,
      tx.original_currency ?? null,
      tx.mcc ?? null,
      category_id,
      real_category_id,
      planned_id,
      display_name ?? tx.description ?? null,
      tx.comment ?? null,
      tx.balance_after ?? null,
      tx.cashback ?? null,
      tx.hold ? 1 : 0,
      transfer,
      tx.raw === undefined ? null : JSON.stringify(tx.raw),
      Math.floor(Date.now() / 1000),
    )
    .run();

  return { inserted: true };
}
