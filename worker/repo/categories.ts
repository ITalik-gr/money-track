// Category reads and writes. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";

export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  color: string | null;
  is_income: number;
  importance: string | null;
  [key: string]: unknown;
}

/**
 * All categories, income buckets last.
 *
 * Names come back RAW (as seeded, in Ukrainian). Localisation is the caller's job via
 * `localizeCatName`, because the resolution is keyed by the seed name and a user's own category
 * must pass through untouched — a repo that translated on read would silently rename data the
 * user typed.
 */
export async function listAll(db: AppDb): Promise<CategoryRow[]> {
  const r = await db.prepare(
    "SELECT * FROM categories ORDER BY is_income, id",
  ).all<CategoryRow>();
  return r.results ?? [];
}

/**
 * Which of these ids actually exist (§FK-GUARD).
 *
 * There are gaps in the id sequence from deleted rows, so a plausible-looking id — whether it
 * came from a model or from a stale client — lands on nothing and the write fails with
 * `FOREIGN KEY constraint failed`. `INSERT OR IGNORE` does NOT cover this: it suppresses a
 * uniqueness conflict, not a foreign-key violation, so one bad id takes the whole batch down.
 * Filter first, write second.
 */
export async function existingIds(db: AppDb, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await db.prepare(
    `SELECT id FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<{ id: number }>();
  return (r.results ?? []).map((x) => x.id);
}

export interface BudgetableCategory {
  id: number;
  name: string;
  color: string | null;
  importance: string | null;
}

/**
 * Top-level expense categories — the candidates an envelope can be set on.
 *
 * Top-level only because budgets are compared against spending rolled up into the parent
 * (`COALESCE(parent_id, id)`); an envelope on a sub-category would be measured against a total
 * that includes its siblings. Income buckets are excluded for the obvious reason.
 */
export async function budgetable(db: AppDb, locale: NotifLocale): Promise<BudgetableCategory[]> {
  const r = await db.prepare(
    `SELECT c.id, ${catNameSql(locale, "c.name")} AS name, c.color, c.importance FROM categories c
     WHERE c.parent_id IS NULL AND COALESCE(c.is_income, 0) = 0`,
  ).all<BudgetableCategory>();
  return r.results ?? [];
}

export async function exists(db: AppDb, id: number): Promise<boolean> {
  return (await db.prepare("SELECT id FROM categories WHERE id = ?").bind(id).first()) != null;
}

// ---- writes -----------------------------------------------------------------

export interface NewCategory {
  name: string;
  color: string;
  icon: string;
  parent_id: number | null;
  is_income: boolean;
  importance: string | null;
}

/** @returns the new id. `is_custom` is always 1 — the seeded ones are inserted by migrations. */
export async function create(db: AppDb, c: NewCategory): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO categories (name, color, icon, parent_id, is_income, is_custom, importance) VALUES (?, ?, ?, ?, ?, 1, ?)",
  ).bind(c.name, c.color, c.icon, c.parent_id, c.is_income ? 1 : 0, c.importance).run();
  return r.meta.last_row_id;
}

/**
 * Partial update — built-in categories are editable too (name/colour/icon/parent/importance).
 *
 * A key that is absent means "leave alone"; `parent_id: null` means "move to the top level", so
 * the two are genuinely different and the caller passes only what it means to change.
 *
 * @returns false when the patch touched nothing, so the caller can skip the write.
 */
export interface CategoryPatch {
  name?: string;
  color?: string;
  icon?: string;
  importance?: string | null;
  parent_id?: number | null;
}

export async function update(db: AppDb, id: number, patch: CategoryPatch): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  for (const col of ["name", "color", "icon", "importance"] as const) {
    const v = patch[col];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (patch.parent_id !== undefined) {
    // A category cannot be its own parent. The guard lives here rather than in the handler
    // because it is a property of the row, not of the request: every future caller of `update`
    // needs it, and one that re-derived it would be the start of the usual divergence.
    sets.push("parent_id = ?");
    binds.push(patch.parent_id === id ? null : patch.parent_id);
  }
  if (!sets.length) return false;

  await db.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return true;
}

/** How much is attached to a category — the input to the "move it where?" dialog before deleting. */
export async function usage(
  db: AppDb, id: number,
): Promise<{ transactions: number; tags: number; subcategories: number }> {
  const tx = await db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE category_id = ? OR real_category_id = ?",
  ).bind(id, id).first<{ n: number }>();
  const tags = await db.prepare("SELECT COUNT(*) AS n FROM transaction_tags WHERE category_id = ?")
    .bind(id).first<{ n: number }>();
  const subs = await db.prepare("SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?")
    .bind(id).first<{ n: number }>();
  return { transactions: tx?.n ?? 0, tags: tags?.n ?? 0, subcategories: subs?.n ?? 0 };
}

// ---- the delete cascade -----------------------------------------------------
//
// Deleting a category means dealing with every foreign key that points at it. One function per
// TABLE, so the handler reads as the ordered list of tables it visits — and the ORDER IS THE
// BEHAVIOUR: `remove()` must come last, because the schema enforces these references and SQLite
// rejects the delete while any of them still stands. Nothing in the type system records that,
// which is why it is written down here.
//
// `target = null` means "unlink" rather than "move". Two tables cannot express it that way:
// `rules.category_id` is NOT NULL, so an unlinked rule is DELETED; and a tag row IS nothing but
// the link, so it goes too.

/** Both category columns: the plain one and `real_category_id` (the withdrawal's true purpose). */
export async function reassignTransactions(db: AppDb, from: number, to: number | null): Promise<void> {
  await db.prepare("UPDATE transactions SET category_id = ? WHERE category_id = ?").bind(to, from).run();
  await db.prepare("UPDATE transactions SET real_category_id = ? WHERE real_category_id = ?").bind(to, from).run();
}

/**
 * Tags are a (transaction_id, category_id) primary key, so moving them can COLLIDE: a transaction
 * already tagged with the target would end up with the same pair twice. The rows that would
 * collide are dropped first, and the rest are moved.
 */
export async function reassignTags(db: AppDb, from: number, to: number | null): Promise<void> {
  if (to != null) {
    await db.prepare(
      "DELETE FROM transaction_tags WHERE category_id = ? AND transaction_id IN (SELECT transaction_id FROM transaction_tags WHERE category_id = ?)",
    ).bind(from, to).run();
    await db.prepare("UPDATE transaction_tags SET category_id = ? WHERE category_id = ?").bind(to, from).run();
  } else {
    await db.prepare("DELETE FROM transaction_tags WHERE category_id = ?").bind(from).run();
  }
}

/** Learned aliases — the foreign key that actually produced a 500 while this step was missing. */
export async function reassignAliases(db: AppDb, from: number, to: number | null): Promise<void> {
  await db.prepare("UPDATE merchant_aliases SET category_id = ? WHERE category_id = ?").bind(to, from).run();
  await db.prepare("UPDATE merchant_aliases SET real_category_id = ? WHERE real_category_id = ?").bind(to, from).run();
}

export async function reassignReceiptItems(db: AppDb, from: number, to: number | null): Promise<void> {
  await db.prepare("UPDATE receipt_items SET category_id = ? WHERE category_id = ?").bind(to, from).run();
}

/** `rules.category_id` is NOT NULL: without a target the rule has nothing left to mean, so it goes. */
export async function reassignRules(db: AppDb, from: number, to: number | null): Promise<void> {
  if (to != null) {
    await db.prepare("UPDATE rules SET category_id = ? WHERE category_id = ?").bind(to, from).run();
  } else {
    await db.prepare("DELETE FROM rules WHERE category_id = ?").bind(from).run();
  }
}

export async function reassignPlanned(db: AppDb, from: number, to: number | null): Promise<void> {
  await db.prepare("UPDATE planned_payments SET category_id = ? WHERE category_id = ?").bind(to, from).run();
}

export async function reassignBudgets(db: AppDb, from: number, to: number | null): Promise<void> {
  await db.prepare("UPDATE budgets SET category_id = ? WHERE category_id = ?").bind(to, from).run();
}

/** Sub-categories are re-parented to the target, or promoted to the top level without one. */
export async function reassignChildren(db: AppDb, from: number, to: number | null): Promise<void> {
  await db.prepare("UPDATE categories SET parent_id = ? WHERE parent_id = ?").bind(to, from).run();
}

/** Last step, and only after every reference above has been dealt with. */
export async function remove(db: AppDb, id: number): Promise<void> {
  await db.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
}
