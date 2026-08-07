// Transaction scenarios — the handlers that are SEQUENCES rather than single queries.
//
// Why a layer at all: `PATCH /transactions/:id` touches tags, then the row, then the §R2-TX4
// cleanup, then the alias table, and every one of those steps depends on the state left by the
// one before it. While that lived inline in a handler the only record of the order was prose in
// a comment, and nothing stopped a second caller from performing four of the five steps.
//
// The layer boundary: a service takes already-parsed input and returns a RESULT — it never reads
// the request, picks a status code, or produces a user-facing string. Naming the failure is the
// service's job; wording it is the route's, which is what keeps `st(locale, …)` out of here.
import type { AppDb } from "../lib/platform/db-shim.ts";
import * as txRepo from "../repo/transactions.ts";
import { normImportance } from "../lib/finance/importance.ts";

export type TxEdit = {
  category_id?: number | null; merchant?: string; user_note?: string; learn?: boolean;
  is_transfer?: boolean; tags?: number[]; event_id?: number | null; real_category_id?: number | null;
  importance?: string | null; lock_name?: boolean;
};

/**
 * Apply a manual edit, optionally learning it as a rule for every matching transaction (§6.3).
 * Returns `null` when the transaction does not exist.
 */
export async function editTransaction(db: AppDb, id: string, b: TxEdit): Promise<{ learned: boolean } | null> {
  const tx = await txRepo.rawById(db, id) as {
    source: string; raw_json: string | null; comment: string | null; mcc: number | null; merchant: string | null;
  } | null;
  if (!tx) return null;

  // §R7: ручна назва авторитетна. Ставимо name_locked=1, коли користувач змінив назву на
  // непорожню й іншу; явний lock_name (кнопка «дозволити AI змінювати») може зняти/поставити.
  const renamed = b.merchant !== undefined && !!b.merchant?.trim() && b.merchant.trim() !== (tx.merchant ?? "").trim();

  // Теги (вторинні категорії, до 3, без основної) — повна заміна набору.
  if (b.tags !== undefined) {
    await txRepo.clearTags(db, id);
    const tags = [...new Set(b.tags)].filter((t) => t !== b.category_id).slice(0, 3);
    for (const t of tags) await txRepo.addTag(db, id, t);
  }

  const patch: txRepo.TxPatch = {};
  if (b.category_id !== undefined) patch.category_id = b.category_id;
  if (b.merchant !== undefined) patch.merchant = b.merchant;
  if (b.user_note !== undefined) patch.user_note = b.user_note;
  if (b.is_transfer !== undefined) patch.is_transfer = b.is_transfer;
  if (b.real_category_id !== undefined) patch.real_category_id = b.real_category_id;
  if (b.event_id !== undefined) patch.event_id = b.event_id;
  if (b.importance !== undefined) patch.importance = normImportance(b.importance);
  if (b.lock_name !== undefined) patch.name_locked = b.lock_name;
  else if (renamed) patch.name_locked = true;
  await txRepo.updateFields(db, id, patch);

  // §R2-TX4: «реальна категорія» має сенс лише для бакета «Перекази і зняття».
  // Для звичайних операцій прибираємо її, щоб не дублювала основну й не плутала.
  await txRepo.clearRealCategoryOutsideTransfers(db, id);

  if (!b.learn) return { learned: false };

  const raw = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }) : null;
  const rawKey = raw?.description?.trim();
  if (!rawKey) return { learned: false };

  const transferFlag = b.is_transfer ? 1 : 0;
  // Реальну категорію переказу зберігаємо в alias; якщо цього разу її не передали —
  // не губимо раніше навчену (беремо з наявного alias).
  const prior = await txRepo.aliasRealCategory(db, rawKey);
  const realCat = b.real_category_id !== undefined ? b.real_category_id : (prior?.real_category_id ?? null);
  // Idempotent: one alias per raw description — a re-edit replaces the old rule.
  // §Хвіст: source='manual' — ця правка захищена, enrich/консенсус її не перетруть.
  await txRepo.deleteAlias(db, rawKey);
  await txRepo.insertManualAlias(db, rawKey, b.merchant ?? null, b.category_id ?? null,
    transferFlag, realCat, Math.floor(Date.now() / 1000));
  // Back-apply to existing matching mono transactions (name, category, transfer flag, real category).
  await txRepo.backApplyAlias(db, b.category_id ?? null, b.merchant ?? null, transferFlag, realCat, rawKey);
  return { learned: true };
}
