// Event groups (a trip, a project, a special day) and their plan line items.
// See `worker/repo/README.md`.
//
// Every total here is rolled up in ₴ through the caller's `mult` (`uahMult(rates)`). Both of the
// aggregate queries below once filtered on `currency_code = 980` instead, so a trip's foreign
// spending simply did not count — and a trip is precisely where foreign currency happens. The
// page and the list then disagreed about the same event. One figure has to be one figure.
import type { AppDb } from "../lib/platform/db-shim.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
import type { EventWithAgg } from "../../shared/api/platform.ts";
import type { TxRow } from "../../shared/api/transactions.ts";
import type { EventGroup } from "../../shared/types.ts";

/** Active events with their transaction count and ₴ totals. Holds are counted like anywhere else. */
export async function listWithTotals(db: AppDb, mult: string): Promise<EventWithAgg[]> {
  const r = await db.prepare(
    `SELECT e.*,
            COUNT(t.id) AS tx_count,
            CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN (-t.amount) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS spent,
            CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount * ${mult} ELSE 0 END), 0)) AS INTEGER) AS income
     FROM event_groups e
     LEFT JOIN transactions t ON t.event_id = e.id
     WHERE e.is_active = 1
     GROUP BY e.id ORDER BY e.created_at DESC`,
  ).all<EventWithAgg>();
  return r.results ?? [];
}

export async function find(db: AppDb, id: number): Promise<EventGroup | null> {
  return await db.prepare("SELECT * FROM event_groups WHERE id = ?").bind(id).first<EventGroup>();
}

export async function create(
  db: AppDb,
  e: { name: string; kind: string; color: string | null; icon: string | null; note: string | null; created_at: number },
): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO event_groups (name, kind, color, icon, note, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).bind(e.name, e.kind, e.color, e.icon, e.note, e.created_at).run();
  return r.meta.last_row_id;
}

/** Partial update; an absent key means "leave alone". @returns false when nothing was set. */
export interface EventPatch {
  /** `null` removes the limit. */
  budget?: number | null;
  name?: string;
  note?: string | null;
  /** §EVENT-GOAL: `null` unlinks the goal. */
  goal_id?: number | null;
}

export async function update(db: AppDb, id: number, patch: EventPatch): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  // §EVENT-GOAL: `goal_id` joins the list. `null` is a MEANINGFUL value here (unlink), which is
  // why the loop tests `undefined` rather than falsiness — the same reason `budget` already did.
  for (const col of ["budget", "name", "note", "goal_id"] as const) {
    const v = patch[col];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (!sets.length) return false;
  await db.prepare(`UPDATE event_groups SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return true;
}

/**
 * Detach the spending, then archive the event — in that order, and never delete a transaction.
 * An event is a LABEL on money that was really spent; removing the label must not remove the
 * money, or archiving a finished trip would silently rewrite the year's statistics.
 */
export async function unlinkTransactions(db: AppDb, id: number): Promise<void> {
  await db.prepare("UPDATE transactions SET event_id = NULL WHERE event_id = ?").bind(id).run();
}

export async function archive(db: AppDb, id: number): Promise<void> {
  await db.prepare("UPDATE event_groups SET is_active = 0 WHERE id = ?").bind(id).run();
}

export async function transactions(
  db: AppDb, locale: NotifLocale, id: number,
): Promise<TxRow[]> {
  const r = await db.prepare(
    `SELECT t.*, ${catNameSql(locale, "c.name")} AS category_name, c.color AS category_color, a.title AS account_title
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.event_id = ? ORDER BY t.time DESC`,
  ).bind(id).all<TxRow>();
  return r.results ?? [];
}

export async function totals(
  db: AppDb, mult: string, id: number,
): Promise<{ spent: number; income: number } | null> {
  return await db.prepare(
    `SELECT CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN (-t.amount) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS spent,
            CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount * ${mult} ELSE 0 END), 0)) AS INTEGER) AS income
     FROM transactions t WHERE t.event_id = ?`,
  ).bind(id).first<{ spent: number; income: number }>();
}

// ---- plan line items (P2.3) -------------------------------------------------
// Amounts are already ₴ minor units, so they compare directly against the ₴ roll-up above.

export interface EventPlannedRow {
  id: number;
  label: string;
  amount: number;
  category_id: number | null;
  category_name: string | null;
}

export async function plannedItems(
  db: AppDb, locale: NotifLocale, eventId: number,
): Promise<EventPlannedRow[]> {
  const r = await db.prepare(
    `SELECT p.id, p.label, p.amount, p.category_id, ${catNameSql(locale, "c.name")} AS category_name
     FROM event_planned p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.event_id = ? ORDER BY p.amount DESC`,
  ).bind(eventId).all<EventPlannedRow>();
  return r.results ?? [];
}

export async function addPlannedItem(
  db: AppDb, eventId: number, label: string, amount: number,
  categoryId: number | null, createdAt: number,
): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO event_planned (event_id, label, amount, category_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(eventId, label, amount, categoryId, createdAt).run();
  return r.meta.last_row_id;
}

/** Scoped by event as well as by id: an id alone would let one event delete another's line. */
export async function deletePlannedItem(db: AppDb, eventId: number, itemId: number): Promise<void> {
  await db.prepare("DELETE FROM event_planned WHERE id = ? AND event_id = ?")
    .bind(itemId, eventId).run();
}
