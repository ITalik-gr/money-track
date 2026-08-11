// §AI-AUDIT — what the model changed on a transaction, and how to put it back.
// See `repo/README.md`. Migration 0041.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { AiChange } from "../../shared/api/ai.ts";

/** Columns the model is allowed to rewrite, and therefore the only ones a revert may touch. */
export const AUDITED_FIELDS = ["category_id", "is_transfer", "ai_note"] as const;
export type AuditedField = (typeof AUDITED_FIELDS)[number];
export const isAuditedField = (v: unknown): v is AuditedField =>
  AUDITED_FIELDS.includes(v as AuditedField);

/** How many entries are kept. A year of enrichment would otherwise outgrow the data it describes. */
const MAX_ROWS = 500;

/**
 * Record one field the model rewrote — but ONLY when it actually changed.
 *
 * An enrichment that confirms the existing category is the common case, and logging it would bury
 * the handful of real changes under thousands of "AI agreed with you". Comparison is on the string
 * form because that is how both values are stored, and `null` compares equal to `null`.
 */
export async function logChange(
  db: AppDb, txId: string, field: AuditedField,
  oldValue: string | number | null, newValue: string | number | null,
  source: string, at: number,
): Promise<void> {
  const o = oldValue == null ? null : String(oldValue);
  const n = newValue == null ? null : String(newValue);
  if (o === n) return;
  await db.prepare(
    "INSERT INTO ai_changes (tx_id, field, old_value, new_value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(txId, field, o, n, source, at).run();
  await prune(db);
}

async function prune(db: AppDb): Promise<void> {
  await db.prepare(
    `DELETE FROM ai_changes WHERE id NOT IN (SELECT id FROM ai_changes ORDER BY id DESC LIMIT ?)`,
  ).bind(MAX_ROWS).run();
}

/** Everything the model did to ONE operation, newest first — for the detail page. */
export async function forTx(db: AppDb, txId: string): Promise<AiChange[]> {
  const r = await db.prepare(
    `SELECT id, tx_id, field, old_value, new_value, source, created_at, reverted_at
     FROM ai_changes WHERE tx_id = ? ORDER BY id DESC`,
  ).bind(txId).all<AiChange>();
  return r.results ?? [];
}

/** The recent log across all operations, with the merchant so a row is readable on its own. */
export async function recent(db: AppDb, limit: number): Promise<AiChange[]> {
  const r = await db.prepare(
    `SELECT a.id, a.tx_id, a.field, a.old_value, a.new_value, a.source, a.created_at, a.reverted_at,
            t.merchant AS merchant
     FROM ai_changes a LEFT JOIN transactions t ON t.id = a.tx_id
     ORDER BY a.id DESC LIMIT ?`,
  ).bind(limit).all<AiChange>();
  return r.results ?? [];
}

export async function byId(db: AppDb, id: number): Promise<AiChange | null> {
  return await db.prepare(
    `SELECT id, tx_id, field, old_value, new_value, source, created_at, reverted_at
     FROM ai_changes WHERE id = ?`,
  ).bind(id).first<AiChange>();
}

/**
 * Put the old value back.
 *
 * The column name is chosen from `AUDITED_FIELDS` by the caller, never interpolated from a
 * request — the same rule the rest of `repo/` follows for identifiers.
 *
 * ⚠️ The log row is MARKED, not deleted. "The AI did this and I undid it" is a more useful fact
 * than an empty log, and keeping it is what lets the screen stop offering the same undo twice.
 */
export async function revert(db: AppDb, change: AiChange, at: number): Promise<void> {
  const value = change.old_value == null ? null
    : change.field === "ai_note" ? change.old_value
      : Number(change.old_value);
  const column = change.field === "category_id" ? "category_id"
    : change.field === "is_transfer" ? "is_transfer" : "ai_note";
  await db.prepare(`UPDATE transactions SET ${column} = ? WHERE id = ?`)
    .bind(value, change.tx_id).run();
  await db.prepare("UPDATE ai_changes SET reverted_at = ? WHERE id = ?").bind(at, change.id).run();
}
