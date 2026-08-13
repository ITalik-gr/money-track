// `bank_connections` — one row per linked credential (BANKS.md §5, step 4).
//
// The table has existed since migration 0032 and NOTHING read or wrote it, which meant the app
// had no answer to two questions it needs the moment there is more than one bank: which credential
// feeds which accounts, and when did that credential last work.
//
// The second question is the one that bites today, with a single bank: a sync that fails at 3 a.m.
// on an expired token leaves a `console.error` in a log the owner does not read, and the app looks
// exactly like an app whose owner simply spent nothing. That is the same defect as a silently
// failed cron report — the product must SAY when a scheduled thing it promised did not happen.
//
// The secret itself never lands here (it lives encrypted in `user_secrets`); this row only records
// that a link exists and how it is doing.
import type { AppDb } from "../lib/platform/db-shim.ts";

/**
 * One credential per provider today, so the id is derived from the provider name.
 *
 * The day a user links two credentials at the same bank (a personal Privat24 and a ФОП one), this
 * becomes a generated id and `accounts.connection_id` is what keeps the two apart — which is
 * exactly why that column is written now, while there is still only one of everything and a
 * mistake is cheap to see.
 */
export function connectionId(providerId: string): string {
  return `conn_${providerId}`;
}

export interface BankConnectionRow {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  last_sync_at: number | null;
  last_error: string | null;
  accounts: number;
}

/**
 * Every linked credential, with how many accounts it feeds.
 *
 * ⚠️ **A bank with accounts but no row yet still appears**, with `last_sync_at: null`. The table
 * only starts being written when a sync RUNS, so on an account that has been syncing daily for
 * months the card said "no bank has synced yet" — which is not a missing feature, it is the app
 * stating something false about itself. The union answers from what is actually there: accounts
 * exist and they came from somewhere.
 *
 * `accounts` counts by `connection_id` for real rows and by `provider` for the synthetic ones,
 * because `connection_id` is only stamped on a successful sync (which, for these, has not
 * happened since the column started being written).
 */
export async function listConnections(db: AppDb): Promise<BankConnectionRow[]> {
  const res = await db
    .prepare(
      `SELECT c.id, c.provider, c.label, c.status, c.last_sync_at, c.last_error,
              (SELECT COUNT(*) FROM accounts a
                WHERE a.is_active = 1 AND (a.connection_id = c.id OR (a.connection_id IS NULL AND a.provider = c.provider))
              ) AS accounts
         FROM bank_connections c

       UNION ALL

       SELECT 'conn_' || a.provider AS id, a.provider, NULL AS label, 'active' AS status,
              NULL AS last_sync_at, NULL AS last_error, COUNT(*) AS accounts
         FROM accounts a
        WHERE a.is_active = 1 AND a.is_manual = 0
          AND a.provider NOT IN ('manual', 'csv')
          AND NOT EXISTS (SELECT 1 FROM bank_connections c2 WHERE c2.provider = a.provider)
        GROUP BY a.provider`,
    )
    .all<BankConnectionRow>();
  return res.results ?? [];
}

/**
 * Records the outcome of talking to a bank, and adopts its accounts on success.
 *
 * ⚠️ **A failure does NOT clear `last_sync_at`.** "Last worked at 09:00, failing since" is the
 * fact worth showing; overwriting the timestamp would turn a broken connection into one that has
 * simply never run, and those need different reactions from the reader.
 *
 * ⚠️ Success clears `last_error`. A stale error next to a fresh timestamp is worse than no error
 * at all — it sends the reader to fix something that already recovered on its own.
 */
export async function recordSync(
  db: AppDb,
  providerId: string,
  label: string | null,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const id = connectionId(providerId);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO bank_connections (id, provider, label, status, last_sync_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = COALESCE(excluded.label, bank_connections.label),
         status = excluded.status,
         last_sync_at = COALESCE(excluded.last_sync_at, bank_connections.last_sync_at),
         last_error = excluded.last_error`,
    )
    .bind(
      id,
      providerId,
      label,
      result.ok ? "active" : "error",
      result.ok ? now : null,
      result.ok ? null : result.error.slice(0, 500),
      now,
    )
    .run();

  if (result.ok) {
    // Accounts of this provider belong to the credential that just answered for them. Manual
    // accounts are excluded on purpose: a hand-kept cash account must never be adopted by a bank
    // and then have its balance overwritten by that bank's next sync.
    await db
      .prepare("UPDATE accounts SET connection_id = ? WHERE provider = ? AND is_manual = 0")
      .bind(id, providerId)
      .run();
  }
}
