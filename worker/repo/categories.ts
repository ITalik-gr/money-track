// Category reads and writes. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { Category } from "../../shared/types.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
import {
  STATS_JOINS, SPEND_WHERE, INCOME_WHERE, EFF_CAT_ID, EFF_CAT_LEAF_ID,
  amountSum, incomeSum, localYmSql,
} from "../lib/finance/stats.ts";

/**
 * §CAT-PAGE — how a category page finds ITS rows, and which side of the ledger it reads.
 *
 * Three facts were entangled and all three produced an empty page on live data:
 *  1. a SUB-category never matches `EFF_CAT_ID` (that rolls up to the parent), so every
 *     sub-category page was blank — while the parent page linked to it;
 *  2. an INCOME category has no spending by definition, so "Зарплата" was all zeros on a page
 *     built entirely out of `SPEND_WHERE`;
 *  3. the page window was month-to-date, so a category with nothing THIS month looked like a
 *     category with nothing ever.
 *
 * (1) and (2) are answered here, once, so every query on the page agrees about which rows and which
 * direction. (3) is the caller's window.
 */
export interface CatScope {
  /** The category id being viewed. */
  id: number;
  /** True when it has no parent — then rows roll UP into it and `EFF_CAT_ID` is right. */
  isParent: boolean;
  /** True when this is an income bucket — then the whole page reads the income side. */
  isIncome: boolean;
}

/** The WHERE fragment selecting this category's rows, on the correct side of the ledger. */
export function catWhere(s: CatScope): string {
  const side = s.isIncome ? INCOME_WHERE : SPEND_WHERE;
  const match = s.isParent ? EFF_CAT_ID : EFF_CAT_LEAF_ID;
  return `${side} AND ${match} = ?`;
}

/** The matching SUM: income is `EFF_INCOME` (§COMPENSATION), spending is the signed canon. */
export function catSum(s: CatScope, mult: string): string {
  return s.isIncome ? incomeSum(mult) : amountSum(mult);
}

/** A row of `categories` — `SELECT *`, so this IS the contract type (see `repo/accounts.ts`). */
export type CategoryRow = Category;

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

/**
 * Top-level EXPENSE categories, for the Telegram bot's inline keyboards.
 *
 * A keyboard has room for about twenty buttons, so this is a LIMITed list rather than the whole
 * tree — and both constraints matter: income buckets on an expense keyboard, or sub-categories
 * mixed in with their parents, produce buttons that all "work" while filing money in the wrong
 * place. `excludeId` drops bucket 13 («Перекази і зняття») for the alert flow, where the question
 * is what the transfer REALLY was and answering "a transfer" is not an answer.
 *
 * Names come back raw, like `listAll` — the bot writes in the owner's language and does not
 * localise (see the i18n note in CLAUDE.md).
 */
export async function topLevelExpense(db: AppDb, excludeId?: number): Promise<{ id: number; name: string }[]> {
  const r = await db.prepare(
    `SELECT id, name FROM categories
      WHERE is_income = 0 AND parent_id IS NULL${excludeId != null ? " AND id != ?" : ""}
      ORDER BY id LIMIT 20`,
  ).bind(...(excludeId != null ? [excludeId] : [])).all<{ id: number; name: string }>();
  return r.results ?? [];
}

/** One category's display name, or null when the id points at nothing (a deleted row). */
export async function nameById(db: AppDb, id: number): Promise<string | null> {
  const r = await db.prepare("SELECT name FROM categories WHERE id = ?").bind(id).first<{ name: string }>();
  return r?.name ?? null;
}

// ---- §CATEGORY-PAGE: the permalink's own reads ------------------------------------------------
//
// Kept here rather than in `repo/analytics.ts` because they are all keyed by ONE category and are
// only ever asked for by its page; the analytics repo answers questions about a period.

/** §CAT-PAGE: `parent_id` and `is_income` decide the SCOPE, so they travel with the row. */
export async function byId(
  db: AppDb, id: number,
): Promise<
  { id: number; name: string; color: string | null; importance: string | null;
    parent_id: number | null; is_income: number } | null
> {
  return await db.prepare(
    "SELECT id, name, color, importance, parent_id, COALESCE(is_income, 0) AS is_income FROM categories WHERE id = ?",
  ).bind(id).first<{
    id: number; name: string; color: string | null; importance: string | null;
    parent_id: number | null; is_income: number;
  }>();
}

export async function childrenOf(
  db: AppDb, loc: NotifLocale, id: number,
): Promise<{ id: number; name: string; color: string | null }[]> {
  const r = await db.prepare(
    `SELECT id, ${catNameSql(loc, "name")} AS name, color FROM categories WHERE parent_id = ? ORDER BY name`,
  ).bind(id).all<{ id: number; name: string; color: string | null }>();
  return r.results ?? [];
}

/**
 * Monthly spending ON this category, rolled up — the same `EFF_CAT_ID` every other screen uses, so
 * the page cannot disagree with the donut it was opened from.
 *
 * ⚠️ `localYmSql`, not a bare `strftime`: keys are built in JS by the caller, and a month grouped
 * in UTC while the key is built in Kyiv misses silently and reads as a ZERO month (§APP_TZ).
 */
export async function monthlyTrend(
  db: AppDb, mult: string, scope: CatScope, from: number, to: number,
): Promise<{ month: string; spent: number }[]> {
  const r = await db.prepare(
    `SELECT ${localYmSql(to)} AS month, ${catSum(scope, mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${catWhere(scope)}
     GROUP BY month ORDER BY month`,
  ).bind(from, to, scope.id).all<{ month: string; spent: number }>();
  return r.results ?? [];
}

/**
 * §CAT-PAGE — everything this category has ever done, independent of the chosen window.
 *
 * The owner's report: "I open some categories and they are empty, though I definitely spent
 * there." They had, just not in the month the page defaulted to. A lifetime row makes the page
 * answer "is there anything here at all" before it answers "how much this month", so an empty
 * period reads as an empty period rather than as an empty category.
 *
 * ⚠️ `COUNT(DISTINCT t.id)`, not `COUNT(*)`: `STATS_JOINS` multiplies a split row into its parts
 * (§SPLIT), and counting rows would report one split purchase as several.
 */
export async function lifetimeStats(
  db: AppDb, mult: string, scope: CatScope,
): Promise<{ total: number; n: number; first_at: number | null; last_at: number | null; months: number }> {
  const r = await db.prepare(
    `SELECT ${catSum(scope, mult)} AS total,
            COUNT(DISTINCT t.id) AS n,
            MIN(t.time) AS first_at,
            MAX(t.time) AS last_at,
            COUNT(DISTINCT ${localYmSql(Math.floor(Date.now() / 1000))}) AS months
     FROM transactions t ${STATS_JOINS}
     WHERE ${catWhere(scope)}`,
  ).bind(scope.id).first<{ total: number; n: number; first_at: number | null; last_at: number | null; months: number }>();
  return {
    total: r?.total ?? 0, n: r?.n ?? 0,
    first_at: r?.first_at ?? null, last_at: r?.last_at ?? null,
    months: r?.months ?? 0,
  };
}

/** Top merchants for this category over the WHOLE history — who this category actually is. */
export async function lifetimeMerchants(
  db: AppDb, mult: string, scope: CatScope, limit = 8,
): Promise<{ merchant: string; spent: number; n: number }[]> {
  const r = await db.prepare(
    `SELECT t.merchant AS merchant, ${catSum(scope, mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE ${catWhere(scope)} AND t.merchant IS NOT NULL AND t.merchant <> ''
     GROUP BY t.merchant ORDER BY spent DESC LIMIT ?`,
  ).bind(scope.id, limit).all<{ merchant: string; spent: number; n: number }>();
  return r.results ?? [];
}

/** §E1 — how much of this category's spending repeats, and how much happened once. */
export async function recurringSplit(
  db: AppDb, mult: string, scope: CatScope, from: number, to: number, recurExpr: string,
): Promise<{ recurring: number; oneoff: number }> {
  const r = await db.prepare(
    `SELECT CASE WHEN ${recurExpr} THEN 'recurring' ELSE 'oneoff' END AS kind, ${catSum(scope, mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${catWhere(scope)}
     GROUP BY kind`,
  ).bind(from, to, scope.id).all<{ kind: string; spent: number }>();
  const out = { recurring: 0, oneoff: 0 };
  for (const row of r.results ?? []) {
    if (row.kind === "recurring") out.recurring = row.spent; else out.oneoff = row.spent;
  }
  return out;
}

/** One category's display name, resolved in the reader's locale (§P3.4). */
export async function nameOf(db: AppDb, locale: NotifLocale, id: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT ${catNameSql(locale, "name")} AS name FROM categories WHERE id = ?`)
    .bind(id)
    .first<{ name: string }>();
  return row?.name ?? null;
}
