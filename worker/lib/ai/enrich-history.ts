/**
 * What the ledger ALREADY says about a merchant — asked before (and instead of) the model.
 *
 * Split out of `enrich.ts` on 2026-09-25 under lint C3 (it sat at exactly 400 lines, and the
 * §CYR-CASE fix below needed four). The seam is real: these two read history and decide nothing
 * alone — `consensusCategory` can answer without a model call at all, `merchantHistory` becomes a
 * line of the model's context — while `enrich.ts` is the model call and the write.
 */
import type { Env } from "../../env.ts";
import type { TxRow } from "./enrich.ts";
import { TRANSFER_CAT } from "../finance/stats.ts";
import { coreToken } from "../finance/merchants.ts";
import { orLikeClause } from "../platform/text.ts";

// Якщо той самий мерчант (за коренем) історично ≥3× потрапляв домінантно (≥80%) в одну
// категорію — застосовуємо її без AI. §Хвіст: ручні правки важать ×3 (вага замість COUNT),
// тож одне явне рішення користувача переважує кілька авто-класифікацій.
// Повертає {category_id, merchant, n} або null (n = зважений голос).
export async function consensusCategory(
  env: Env,
  tx: TxRow,
): Promise<{ category_id: number; merchant: string | null; n: number } | null> {
  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description ?? null : null;
  const token = coreToken(rawDesc ?? tx.merchant);
  if (!token) return null;
  // §CYR-CASE: `coreToken` lower-cases, and `LOWER(x) LIKE` folds ASCII only — so a Cyrillic
  // merchant («Київстар», «КИЇВСТАР») never found its own history and never reached consensus.
  const match = orLikeClause(["t.merchant", "json_extract(t.raw_json, '$.description')"], token);
  const rows = await env.DB.prepare(
    `SELECT t.category_id AS cat, t.merchant AS merchant,
            SUM(CASE WHEN ma.id IS NOT NULL THEN 3 ELSE 1 END) AS n
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN merchant_aliases ma ON ma.match_type = 'mono_desc' AND ma.source = 'manual'
            AND ma.raw_key = json_extract(t.raw_json, '$.description')
     WHERE t.id != ? AND t.category_id IS NOT NULL AND t.is_transfer = 0
       AND COALESCE(c.parent_id, t.category_id) != ${TRANSFER_CAT}
       AND ${match.sql}
     GROUP BY t.category_id, t.merchant`,
  ).bind(tx.id, ...match.binds).all<{ cat: number; merchant: string | null; n: number }>();
  const list = rows.results ?? [];
  if (!list.length) return null;

  let total = 0;
  const byCat = new Map<number, number>();
  const byMerchant = new Map<string, number>();
  for (const r of list) {
    total += r.n;
    byCat.set(r.cat, (byCat.get(r.cat) ?? 0) + r.n);
    if (r.merchant) byMerchant.set(r.merchant, (byMerchant.get(r.merchant) ?? 0) + r.n);
  }
  const [topCat, topN] = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topN < 3 || topN / total < 0.8) return null; // недостатньо впевнено — лишаємо AI
  const merchant = [...byMerchant.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { category_id: topCat, merchant, n: topN };
}

// Як користувач раніше класифікував цього мерчанта — контекст для точнішого AI.
export async function merchantHistory(env: Env, tx: TxRow): Promise<string | null> {
  if (!tx.merchant) return null;
  const row = await env.DB.prepare(
    `SELECT c.name AS name, COUNT(*) AS n
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE t.merchant = ? AND t.id != ? AND t.category_id IS NOT NULL
     GROUP BY t.category_id ORDER BY n DESC LIMIT 1`,
  ).bind(tx.merchant, tx.id).first<{ name: string; n: number }>();
  return row ? `"${tx.merchant}" was previously classified as "${row.name}" (${row.n}×)` : null;
}
