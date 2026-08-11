// Categorisation rules (`rules`) — the deterministic layer of `categorize()`. See `repo/README.md`.
//
// The table has existed since migration 0001 and carries ~100 seeded MCC rules, but nothing could
// ever write to it except a seed and a category-delete cascade: a rule could only be added by
// editing the database by hand. That is what these functions exist to end.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { RuleRow } from "../../shared/api/rules.ts";

/**
 * Rules with their category's name, custom ones FIRST.
 *
 * "Custom" here means anything that is not a seeded MCC rule, and the ordering is the point: the
 * seed is ~100 MCC lines nobody reads, while the handful a person wrote themselves is the whole
 * reason they opened this screen. Sorting purely by priority would bury them.
 */
export async function listAll(db: AppDb, nameExpr: string): Promise<RuleRow[]> {
  const r = await db.prepare(
    `SELECT r.id, r.match_type, r.pattern, r.category_id, r.priority,
            ${nameExpr} AS category_name, c.color AS category_color
     FROM rules r LEFT JOIN categories c ON c.id = r.category_id
     ORDER BY (r.match_type = 'mcc' AND r.priority = 10) ASC, r.priority DESC, r.id DESC`,
  ).all<RuleRow>();
  return r.results ?? [];
}

export async function create(
  db: AppDb, rule: { match_type: string; pattern: string; category_id: number; priority: number },
): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES (?, ?, ?, ?)",
  ).bind(rule.match_type, rule.pattern, rule.category_id, rule.priority).run();
  return r.meta.last_row_id;
}

export async function update(
  db: AppDb, id: number, patch: { pattern?: string; category_id?: number; priority?: number },
): Promise<void> {
  // Column names are literals in this file and values are always bound — the partial-update
  // builder pattern used across `repo/` (see `repo/README.md` on why no identifier is ever
  // interpolated from a request).
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (patch.pattern !== undefined) { sets.push("pattern = ?"); binds.push(patch.pattern); }
  if (patch.category_id !== undefined) { sets.push("category_id = ?"); binds.push(patch.category_id); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); binds.push(patch.priority); }
  if (!sets.length) return;
  await db.prepare(`UPDATE rules SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
}

export async function remove(db: AppDb, id: number): Promise<void> {
  await db.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
}

export async function byId(
  db: AppDb, id: number,
): Promise<{ id: number; match_type: string; pattern: string; category_id: number } | null> {
  return await db.prepare("SELECT id, match_type, pattern, category_id FROM rules WHERE id = ?")
    .bind(id).first<{ id: number; match_type: string; pattern: string; category_id: number }>();
}

/**
 * The text a `text` rule is matched against, as SQL — the stored mirror of what `categorize()`
 * builds in JS from `description` + `comment`.
 *
 * `raw_json.$.description` FIRST: that is the bank's original text, which is what the engine sees
 * at ingest. `merchant` is the fallback for manual and CSV rows, where it IS the description and
 * no `raw_json` exists. Never `merchant` first — for an enriched row it is a name the engine has
 * never seen.
 */
const textHaystack = (a = "t.") =>
  `COALESCE(json_extract(${a}raw_json, '$.description'), ${a}merchant, '') || ' ' || COALESCE(${a}comment, '')`;

/**
 * What a rule WOULD do to the operations already stored — matches, and how many are still
 * uncategorised.
 *
 * A rule is a standing instruction about future money, so the only way to judge one before saving
 * it is to run it against the past. `n_uncategorised` is separate from `n` because those are the
 * only rows an apply may safely touch: a transaction the user (or a learned alias) already
 * categorised must not be silently re-filed by a text substring.
 *
 * ⚠️ **The haystack must stay identical to `categorize()`'s** — see `textHaystack` above. This
 * was wrong when the feature shipped on 2026-08-12: the preview searched the CURRENT `merchant`,
 * which AI enrichment rewrites into a clean name ("Silpo"), while the engine searched the raw bank
 * description ("SILPO 1234 KYIV"). A person would write a rule against the name on their screen,
 * see it match, save it — and it would never fire on anything arriving afterwards.
 * ⚠️ `LOWER()` in SQLite folds ASCII only, so Cyrillic patterns are compared with `LIKE`, which is
 * case-insensitive for ASCII and exact for the rest — the same asymmetry `categorize()` lives with
 * (it lower-cases in JS). Close enough for a preview, and stated rather than hidden.
 */
export async function preview(
  db: AppDb, matchType: string, pattern: string, since: number,
): Promise<{ n: number; n_uncategorised: number; samples: { id: string; merchant: string | null; time: number }[] }> {
  const where = matchType === "mcc" ? "CAST(t.mcc AS TEXT) = ?" : `${textHaystack()} LIKE ?`;
  const bind = matchType === "mcc" ? pattern : `%${pattern}%`;

  const counts = await db.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN t.category_id IS NULL THEN 1 ELSE 0 END) AS n_unc
     FROM transactions t WHERE t.time >= ? AND ${where}`,
  ).bind(since, bind).first<{ n: number; n_unc: number }>();

  const rows = await db.prepare(
    `SELECT t.id, t.merchant, t.time FROM transactions t
     WHERE t.time >= ? AND ${where} ORDER BY t.time DESC LIMIT 5`,
  ).bind(since, bind).all<{ id: string; merchant: string | null; time: number }>();

  return {
    n: counts?.n ?? 0,
    n_uncategorised: counts?.n_unc ?? 0,
    samples: rows.results ?? [],
  };
}

/**
 * Apply a rule to operations that have NO category yet.
 *
 * Deliberately never touches a row that already has one. A rule is a guess about text; a stored
 * category is either the bank's MCC, a learned alias, the AI's enrichment or the person's own
 * decision — and overwriting any of those from a substring match would be the app quietly
 * disagreeing with work already done. The uncategorised rows are exactly what the "N uncategorized
 * transactions" feed item is about, so this closes that loop instead of opening a new one.
 */
export async function applyToUncategorised(
  db: AppDb, matchType: string, pattern: string, categoryId: number, since: number,
): Promise<number> {
  // The same haystack, unaliased — this UPDATE has no join to alias.
  const where = matchType === "mcc" ? "CAST(mcc AS TEXT) = ?" : `${textHaystack("")} LIKE ?`;
  const bind = matchType === "mcc" ? pattern : `%${pattern}%`;
  const r = await db.prepare(
    `UPDATE transactions SET category_id = ? WHERE category_id IS NULL AND time >= ? AND ${where}`,
  ).bind(categoryId, since, bind).run();
  return r.meta.changes ?? 0;
}
