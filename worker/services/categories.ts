// Category scenarios. The one that needs a layer is the delete: it is a CASCADE across eight
// tables, and the ORDER of the steps IS the behaviour — nothing in the type system records it,
// and the schema's foreign keys turn a step performed too late into a 500 in production (which
// is exactly how this was found). Keeping the sequence in one named function is what stops a
// second caller from doing seven of the eight steps.
import type { AppDb } from "../lib/platform/db-shim.ts";
import * as categoriesRepo from "../repo/categories.ts";

/**
 * Delete a category, moving everything that pointed at it to `target` (or detaching it when
 * `target` is null). What "detach" means differs per table and is documented at each repo call.
 */
export async function deleteCategory(db: AppDb, id: number, target: number | null): Promise<void> {
  // Every table referencing the category is dealt with first; the row itself goes LAST.
  await categoriesRepo.reassignTransactions(db, id, target);
  await categoriesRepo.reassignTags(db, id, target);
  await categoriesRepo.reassignAliases(db, id, target);
  await categoriesRepo.reassignReceiptItems(db, id, target);
  await categoriesRepo.reassignRules(db, id, target);
  await categoriesRepo.reassignPlanned(db, id, target);
  await categoriesRepo.reassignBudgets(db, id, target);
  await categoriesRepo.reassignChildren(db, id, target);
  await categoriesRepo.remove(db, id);
}
