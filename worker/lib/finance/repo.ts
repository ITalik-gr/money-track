// D1 persistence helpers: account sync from mono client-info and idempotent
// transaction upsert (mono order is not guaranteed, so upsert-by-id guards dupes).
import type { MonoAccount, MonoClientInfo, MonoJar, MonoStatementItem } from "../bank/mono.ts";
import { categorize } from "./categorize.ts";
import { descriptionIsTransfer } from "./transfers.ts";
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

/** Idempotent upsert of a mono statement item; runs categorisation on insert. */
export async function upsertMonoTx(
  db: AppDb,
  accountId: string,
  item: MonoStatementItem,
): Promise<void> {
  const existing = await db
    .prepare("SELECT id, amount, transfer_pair_id FROM transactions WHERE id = ?")
    .bind(item.id)
    .first<{ id: string; amount: number; transfer_pair_id: string | null }>();

  // §R2-CUR1: item.amount — у валюті РАХУНКУ, тож currency_code беремо з рахунку.
  // item.operationAmount/currencyCode — валюта операції → зберігаємо як original_*.
  const acc = await db
    .prepare("SELECT currency_code FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ currency_code: number | null }>();

  // An event may arrive for an account we have never synced — the user opens a new card or jar
  // and monobank pushes its first operation before the app has fetched client-info. Since
  // `transactions.account_id` is `NOT NULL REFERENCES accounts(id)` and the Durable Object
  // enforces foreign keys, the insert below used to fail with a 500 and the operation was LOST
  // until monobank happened to retry — i.e. whether money appeared in the app depended on
  // someone else's retry policy. So we mint a STUB row instead: identity only, everything else
  // left NULL for the next `syncAccounts` to fill in.
  //
  // `title`/`type` are deliberately NULL rather than a placeholder string: the client already
  // falls back to a type label when the title is empty, and a real-looking made-up name would
  // survive as data. The currency is the one honest guess we can make — `item.currencyCode` is
  // the OPERATION currency, which equals the account's in the common case and is the same value
  // the transaction itself falls back to below, so the row and its account cannot disagree.
  if (!acc) {
    await db
      .prepare(
        `INSERT INTO accounts (id, currency_code, balance, credit_limit, is_manual, is_active, updated_at)
         VALUES (?, ?, ?, 0, 0, 1, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(accountId, item.currencyCode, item.balance ?? 0, Math.floor(Date.now() / 1000))
      .run();
  }

  const accountCurrency = acc?.currency_code ?? item.currencyCode;

  const { category_id, display_name, is_transfer, real_category_id, planned_id } = await categorize(db, {
    mcc: item.mcc,
    description: item.description,
    comment: item.comment,   // §RULES-UI: text rules match description + comment, as the preview does
    amount: item.amount,           // у валюті рахунку — як і currency нижче
    currency_code: accountCurrency,
  });
  const merchant = display_name ?? item.description ?? null;
  const transfer = is_transfer || descriptionIsTransfer(item.description) ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);
  // original лишаємо тільки коли валюта операції реально відрізняється від рахунку.
  const hasOriginal =
    item.operationAmount != null && item.currencyCode !== accountCurrency;
  const originalAmount = hasOriginal ? item.operationAmount! : null;
  const originalCurrency = hasOriginal ? item.currencyCode : null;

  if (existing) {
    // Пару збирають по РІВНИХ протилежних сумах, а detectTransfers тепер парує й холди.
    // Якщо сеттлмент змінив суму — стара пара більше не рівна: розпарюємо ОБИДВІ сторони
    // (вони ділять один transfer_pair_id), щоб наступний detectTransfers зібрав заново.
    // Інакше «+» сторона лишилась би схованою в списку назавжди.
    if (existing.transfer_pair_id && existing.amount !== item.amount) {
      await db
        .prepare("UPDATE transactions SET transfer_pair_id = NULL WHERE transfer_pair_id = ?")
        .bind(existing.transfer_pair_id)
        .run();
    }
    // Refresh volatile fields (hold -> settled, balance) but keep manual edits to category/note.
    await db
      .prepare(
        `UPDATE transactions SET amount=?, balance_after=?, hold=?, comment=?, raw_json=? WHERE id=?`,
      )
      .bind(item.amount, item.balance, item.hold ? 1 : 0, item.comment ?? null, JSON.stringify(item), item.id)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO transactions
        (id, account_id, source, time, amount, currency_code, original_amount, original_currency,
         mcc, category_id, real_category_id, planned_id, merchant,
         comment, balance_after, cashback, hold, is_transfer, raw_json, created_at)
       VALUES (?, ?, 'mono', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      accountId,
      item.time,
      item.amount,
      accountCurrency,
      originalAmount,
      originalCurrency,
      item.mcc ?? null,
      category_id,
      real_category_id,
      planned_id,
      merchant,
      item.comment ?? null,
      item.balance,
      item.cashbackAmount ?? null,
      item.hold ? 1 : 0,
      transfer,
      JSON.stringify(item),
      now,
    )
    .run();
}
