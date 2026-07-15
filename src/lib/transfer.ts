// Подача переказів між СВОЇМИ рахунками — ЄДИНЕ джерело правила для UI.
// Використовують і `TxItem` (список), і `TxDetail` (шапка), щоб вони не розповзлися.
import { accountLabel } from "./merchant.ts";

export interface TransferShape {
  amount: number;
  is_transfer?: number;
  real_category_id?: number | null;
  transfer_pair_id?: string | null;
  account_title?: string | null;
  pair_account_title?: string | null;
}

/**
 * Операція нейтральна (без знака й без червоного/зеленого), коли гроші НЕ покинули
 * власні кошти. Дзеркалить `SPEND_WHERE`/`INCOME_WHERE` зі `stats.ts`: там витратою НЕ
 * рахується пара (`transfer_pair_id IS NOT NULL`) і переказ без реальної категорії
 * (`is_transfer = 1 AND real_category_id IS NULL`). Тож «−4 000 ₴» червоним було подвійно
 * хибним: у статистиці цих грошей і так немає, а картці вони просто змінили рахунок.
 *
 * ВАЖЛИВО: зняття готівки з проставленою реальною категорією (`real_category_id`) —
 * НЕ нейтральне. Stats рахує його витратою, тож і виглядати воно має витратою.
 */
export function isNeutralTransfer(t: TransferShape): boolean {
  if (t.transfer_pair_id) return true;
  return !!t.is_transfer && t.real_category_id == null;
}

/** «Звідки → куди» для пари. Мінусова сторона — джерело, плюсова — призначення. */
export function transferRoute(t: TransferShape): { from: string; to: string } | null {
  if (!t.transfer_pair_id || !t.account_title || !t.pair_account_title) return null;
  const self = accountLabel(t.account_title);
  const other = accountLabel(t.pair_account_title);
  return t.amount < 0 ? { from: self, to: other } : { from: other, to: self };
}
