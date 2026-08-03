// Transaction reads. See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import { catNameSql } from "../lib/finance/categories-i18n.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";

/**
 * Feed filter, already parsed and coerced by the route.
 *
 * The route owns parsing (`?amin=` is a string in ₴ and arrives from the client); the repo owns
 * the query. Splitting it here means the WHERE-clause builder below is the only place that knows
 * how a filter becomes SQL — previously it was inline in the handler, so nothing else could
 * reuse it and the next feature would have written its own.
 */
export interface FeedFilter {
  limit: number;
  offset: number;
  category?: number;
  /** Roll up into this parent, i.e. include its sub-categories. */
  catparent?: number;
  account?: string;
  type?: "expense" | "income";
  from?: number;
  to?: number;
  /** Free text over merchant / comment / note / event name. */
  q?: string;
  /** Amount bounds in MINOR units, compared on absolute value. */
  aminMinor?: number;
  amaxMinor?: number;
}

function buildWhere(f: FeedFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  // §R5: a detected transfer shows as ONE row — hide the incoming (+) leg of the pair.
  where.push("NOT (t.transfer_pair_id IS NOT NULL AND t.amount > 0)");
  if (f.category !== undefined) { where.push("t.category_id = ?"); binds.push(f.category); }
  if (f.catparent !== undefined) { where.push("COALESCE(c.parent_id, t.category_id) = ?"); binds.push(f.catparent); }
  if (f.type === "expense") where.push("t.amount < 0");
  if (f.type === "income") where.push("t.amount > 0");
  if (f.account !== undefined) { where.push("t.account_id = ?"); binds.push(f.account); }
  if (f.from !== undefined) { where.push("t.time >= ?"); binds.push(f.from); }
  if (f.to !== undefined) { where.push("t.time <= ?"); binds.push(f.to); }
  // Compared on absolute value. Currencies are NOT converted — the filter is on the account's
  // own denomination, which is what the amount in the row means.
  if (f.aminMinor !== undefined) { where.push("ABS(t.amount) >= ?"); binds.push(f.aminMinor); }
  if (f.amaxMinor !== undefined) { where.push("ABS(t.amount) <= ?"); binds.push(f.amaxMinor); }
  if (f.q !== undefined) {
    where.push("(t.merchant LIKE ? OR t.comment LIKE ? OR t.user_note LIKE ? OR e.name LIKE ?)");
    binds.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/**
 * The transaction feed, newest first, with the display joins the list needs.
 *
 * The self-join on `transfer_pair_id` resolves the other leg of a transfer into a
 * "from → to" label. It joins nothing when `transfer_pair_id` is NULL (NULL = NULL is false in
 * SQL), so ordinary transactions are unaffected by it.
 */
export async function listFeed(
  db: AppDb,
  locale: NotifLocale,
  filter: FeedFilter,
): Promise<Record<string, unknown>[]> {
  const { clause, binds } = buildWhere(filter);
  const r = await db.prepare(
    `SELECT t.*, ${catNameSql(locale, "c.name")} AS category_name, c.color AS category_color, c.icon AS category_icon,
            a.title AS account_title, e.name AS event_name, e.color AS event_color,
            ap.title AS pair_account_title
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     LEFT JOIN transactions tp ON tp.transfer_pair_id = t.transfer_pair_id AND tp.id <> t.id
     LEFT JOIN accounts ap ON ap.id = tp.account_id
     ${clause}
     ORDER BY t.time DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, filter.limit, filter.offset)
    .all();
  return r.results ?? [];
}
