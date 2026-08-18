/**
 * §CAT-PAGE — drilling INTO one category: its sub-categories, merchants and operations.
 *
 * Extracted from `routes/api/analytics.ts` (2026-08-14) when the scope resolution pushed that file
 * past its C3 ceiling. A good seam on its own terms: the route reads a query string, while
 * "which rows belong to this category, on which side of the ledger" is a domain question — the
 * same reasoning that moved `cashflow.ts` and `networth.ts` out of the same file.
 *
 * ⚠️ **The SCOPE is resolved here, from the category itself.** This drill used to assume what the
 * Stats donut always passes: a top-level EXPENSE category. The category permalink can open any
 * category, and the two other cases both produced an empty list — a sub-category never matches the
 * rolled-up `EFF_CAT_ID`, and an income bucket has no spending at all. Deciding it once, next to
 * the queries, is what stops the next caller re-introducing the assumption.
 */
import type { AppDb } from "../platform/db-shim.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import type { CategoryDrill } from "../../../shared/api/analytics.ts";

/** The bucket whose contents are deliberately OUTSIDE canonical spending (§Канон). */
const TRANSFER_CAT = 13;

export async function categoryDrill(
  db: AppDb, loc: NotifLocale,
  v: { mult: string; curFilter: string },
  range: { from: number; to: number },
  category: number,
): Promise<CategoryDrill> {
  if (category === TRANSFER_CAT) {
    // «Перекази і зняття»: незакриті рухи (готівка/зняття без реальної категорії) + справжні
    // перекази. Інформативно, ПОЗА канонічними витратами; групуємо за реальною суттю.
    const [subs, merchants, transactions] = await Promise.all([
      analyticsRepo.transferBucketSubs(db, loc, v, range),
      analyticsRepo.transferBucketMerchants(db, v, range),
      analyticsRepo.transferBucketTransactions(db, loc, v, range),
    ]);
    return { subs, merchants, transactions };
  }

  const row = await categoriesRepo.byId(db, category);
  const scope = { isParent: row?.parent_id == null, isIncome: !!row?.is_income };

  const [subs, merchants, transactions] = await Promise.all([
    analyticsRepo.categorySubs(db, loc, v, range, category, scope),
    analyticsRepo.categoryMerchants(db, v, range, category, scope),
    analyticsRepo.categoryTransactions(db, loc, v, range, category, scope),
  ]);
  return { subs, merchants, transactions };
}
