// D1 persistence helpers: account sync from mono client-info and idempotent
// transaction upsert (mono order is not guaranteed, so upsert-by-id guards dupes).
import { monoToCanonical, type MonoAccount, type MonoClientInfo, type MonoJar, type MonoStatementItem } from "../bank/mono.ts";
import { accountCurrencyForIngest, upsertCanonicalTx } from "../../repo/ingest.ts";
import type { AppDb, AppPreparedStatement } from "../platform/db-shim.ts";

export async function getState(db: AppDb, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: AppDb, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}

function accountTitle(a: MonoAccount): string {
  const pan = a.maskedPan?.[0];
  return `${a.type}${pan ? ` ${pan}` : ""}`;
}

/** Upsert mono cards + jars into accounts. One card may appear per currency. */
export async function syncAccounts(db: AppDb, info: MonoClientInfo): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stmts: AppPreparedStatement[] = [];

  for (const a of info.accounts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual, iban, is_active, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             type=excluded.type, title=excluded.title, currency_code=excluded.currency_code,
             balance=excluded.balance, credit_limit=excluded.credit_limit,
             iban=excluded.iban, updated_at=excluded.updated_at`,
        )
        .bind(a.id, a.type, accountTitle(a), a.currencyCode, a.balance, a.creditLimit, a.iban ?? null, now),
    );
  }

  for (const j of info.jars ?? ([] as MonoJar[])) {
    stmts.push(
      db
        .prepare(
          // Title беремо лише при першому інсерті — ручне перейменування банки має
          // пережити наступний синк (mono віддає generic «БАНКА»).
          // COALESCE, а не пропуск: рядок міг зʼявитись заглушкою з вебхука (див. upsertMonoTx),
          // і тоді title/type порожні — їх треба ЗАПОВНИТИ, але не перетерти те, що вже є.
          `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual, is_active, updated_at)
           VALUES (?, 'jar', ?, ?, ?, 0, 0, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             type=COALESCE(accounts.type, excluded.type),
             title=COALESCE(accounts.title, excluded.title),
             currency_code=excluded.currency_code,
             balance=excluded.balance, updated_at=excluded.updated_at`,
        )
        .bind(j.id, j.title, j.currencyCode, j.balance, now),
    );
  }

  if (stmts.length) await db.batch(stmts);
}

/**
 * A monobank statement item → the canonical shape, then the ONE writer (`repo/ingest.ts`).
 *
 * What is left here is normalisation and nothing else, which is the rule stated in
 * `providers/provider.ts`: sign, currency and minor units are decided in exactly one place per
 * provider. The writing itself is shared, so a second bank cannot end up with its own idea of
 * what "already stored" or "internal transfer" means (BANKS.md §4.4).
 */
export async function upsertMonoTx(
  db: AppDb,
  accountId: string,
  item: MonoStatementItem,
): Promise<void> {
  // §STUB-ACC: an event may arrive for an account we have never synced (a card or jar opened
  // minutes ago), and the resolver mints a stub so the operation is never lost. The fallback
  // currency is the OPERATION's, which is also what `monoToCanonical` falls back to.
  const accountCurrency = await accountCurrencyForIngest(db, accountId, {
    currency_code: item.currencyCode,
    balance: item.balance,
  });

  await upsertCanonicalTx(
    db,
    monoToCanonical(item, accountId, accountCurrency),
    // A webhook re-sends the same id when a hold settles, so the row must be overwritten in
    // place — that is what keeps one purchase one row instead of two.
    { source: "mono", onConflict: "refresh" },
  );
}
