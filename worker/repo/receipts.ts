// Receipt / OCR line-item reads. See `worker/repo/README.md`.
//
// A receipt's date is `purchased_at` when OCR managed to read one, and `created_at` otherwise.
// That `COALESCE` is repeated in every query here on purpose: it is what "when did this
// purchase happen" means for a receipt, and splitting it out as a helper string would hide the
// one thing a reader of these queries needs to know.
import type { AppDb } from "../lib/platform/db-shim.ts";

export interface TopItem { name: string; total: number; qty: number; n: number }

/** Top line items by spend in a window, grouped on the normalised (lower/trimmed) name. */
export async function topItems(
  db: AppDb, from: number, to: number, limit: number,
): Promise<TopItem[]> {
  const r = await db.prepare(
    `SELECT LOWER(TRIM(ri.name)) AS name, CAST(COALESCE(SUM(ri.price), 0) AS INTEGER) AS total,
            ROUND(COALESCE(SUM(COALESCE(ri.qty, 1)), 0), 2) AS qty, COUNT(*) AS n
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE ri.name IS NOT NULL AND ri.name <> '' AND ri.price > 0
       AND COALESCE(r.purchased_at, r.created_at) >= ? AND COALESCE(r.purchased_at, r.created_at) <= ?
     GROUP BY LOWER(TRIM(ri.name)) ORDER BY total DESC LIMIT ?`,
  ).bind(from, to, limit).all<TopItem>();
  return r.results ?? [];
}

/** How many receipts and line items the window covers — used to decide whether to show the
 *  section at all, since an empty receipts table should not render as "0 ₴ of groceries". */
export async function windowMeta(
  db: AppDb, from: number, to: number,
): Promise<{ receipts: number; items: number } | null> {
  return await db.prepare(
    `SELECT COUNT(*) AS receipts, COALESCE(SUM(cnt), 0) AS items FROM (
       SELECT r.id, COUNT(ri.id) AS cnt FROM receipts r JOIN receipt_items ri ON ri.receipt_id = r.id
       WHERE COALESCE(r.purchased_at, r.created_at) >= ? AND COALESCE(r.purchased_at, r.created_at) <= ?
       GROUP BY r.id)`,
  ).bind(from, to).first<{ receipts: number; items: number }>();
}

export interface PricePoint { name: string; at: number; price: number; qty: number }

/**
 * Every priced line item in the window, oldest first — the input to price-drift (§E4).
 *
 * Returns raw rows rather than a computed drift: the unit price is `price / qty`, and the
 * comparison splits each item's occurrences into an early and a late half. That is analysis,
 * not retrieval, so it stays with the caller.
 */
export async function pricePoints(
  db: AppDb, from: number, to: number,
): Promise<PricePoint[]> {
  const r = await db.prepare(
    `SELECT LOWER(TRIM(ri.name)) AS name, COALESCE(r.purchased_at, r.created_at) AS at,
            ri.price AS price, COALESCE(ri.qty, 1) AS qty
     FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
     WHERE ri.name IS NOT NULL AND ri.name <> '' AND ri.price > 0 AND COALESCE(ri.qty, 1) > 0
       AND COALESCE(r.purchased_at, r.created_at) >= ? AND COALESCE(r.purchased_at, r.created_at) <= ?
     ORDER BY at ASC`,
  ).bind(from, to).all<PricePoint>();
  return r.results ?? [];
}
