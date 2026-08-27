/**
 * §F2 step 2 — what a TRANSFER or a cash withdrawal actually was.
 *
 * Split out of `lib/ai/enrich.ts` on 2026-08-27 under lint C3, and the seam is one the file
 * already drew for itself with a divider comment. Enrichment answers "what is this operation";
 * this answers a narrower and later question about the rows enrichment has already parked in
 * bucket 13 — money that left the account without saying what for. Different inputs (the learned
 * real category, the history of this merchant's transfers), a different write (`real_category_id`,
 * never `category_id`), and its own review flow with a human hint.
 *
 * The import runs ONE WAY — this file reaches back into `enrich.ts` for `proposeTransferCategory`
 * and `TxRow`, and exports nothing to it. The four callers in `routes/api/transfers.ts` import
 * from here directly rather than through a re-export, which would close a cycle (the reason
 * `facts.ts` left `advisor.ts` in August, and `budget.ts` and `health.ts` this week).
 */
import type { Env } from "../../env.ts";
import { proposeTransferCategory, TRANSFER_CAT, type TxRow } from "./enrich.ts";
import { MODEL_SMART } from "./models.ts";
import { logUsage } from "./cost.ts";

// §F2 крок 2 --------------------------------------------------------------------

// Як користувач/AI раніше визначали РЕАЛЬНУ категорію переказів цього мерчанта.
async function realCategoryHistory(env: Env, tx: TxRow): Promise<string | null> {
  if (!tx.merchant) return null;
  const row = await env.DB.prepare(
    `SELECT c.name AS name, COUNT(*) AS n
     FROM transactions t JOIN categories c ON c.id = t.real_category_id
     WHERE t.merchant = ? AND t.id != ? AND t.real_category_id IS NOT NULL
     GROUP BY t.real_category_id ORDER BY n DESC LIMIT 1`,
  ).bind(tx.merchant, tx.id).first<{ name: string; n: number }>();
  return row ? `a similar transfer "${tx.merchant}" was previously classified as "${row.name}" (${row.n}×)` : null;
}

// Навчений alias уже несе реальну категорію переказу? (сирий опис, потім mcc).
async function learnedRealCategory(env: Env, tx: TxRow): Promise<number | null | undefined> {
  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
  if (rawDesc) {
    const byDesc = await env.DB.prepare(
      "SELECT real_category_id FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ? AND real_category_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    ).bind(rawDesc).first<{ real_category_id: number }>();
    if (byDesc) return byDesc.real_category_id;
  }
  if (tx.mcc != null) {
    const byMcc = await env.DB.prepare(
      "SELECT real_category_id FROM merchant_aliases WHERE match_type = 'mcc' AND raw_key = ? AND real_category_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    ).bind(String(tx.mcc)).first<{ real_category_id: number }>();
    if (byMcc) return byMcc.real_category_id;
  }
  return undefined; // нічого не навчено
}

export async function categorizeTransferOne(env: Env, tx: TxRow): Promise<void> {
  // 1. Спершу — навчене (без AI-вартості).
  const learned = await learnedRealCategory(env, tx);
  if (learned !== undefined) {
    await env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?").bind(learned, tx.id).run();
    return;
  }

  // 2. Інакше — AI. Реальну категорію не змішуємо з category_id (лишається бакет 13).
  const history = await realCategoryHistory(env, tx);
  const { result, usage } = await proposeTransferCategory(env, {
    merchant: tx.merchant, comment: tx.comment, mcc: tx.mcc,
    amount: tx.amount, currency_code: tx.currency_code, history,
  });
  logUsage("transfer-cat", usage);

  await env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?")
    .bind(result.real_category_id ?? null, tx.id).run();

  // Навчання: запам'ятовуємо реальну категорію на сирому описі, щоб схожі авто-розмічались.
  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
  if (tx.source === "mono" && rawDesc && result.real_category_id != null) {
    await env.DB.prepare(
      "UPDATE merchant_aliases SET real_category_id = ? WHERE match_type = 'mono_desc' AND raw_key = ?",
    ).bind(result.real_category_id, rawDesc).run();
  }
}

// Пройтись по операціях у бакеті «Перекази і зняття» без реальної категорії. Малий
// батч за виклик; клієнт повторює, поки remaining > 0 (як enrichPending).
const TRANSFER_TARGET =
  `SELECT t.* FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
   WHERE t.amount < 0 AND t.is_transfer = 0 AND t.hold = 0 AND t.real_category_id IS NULL
     AND COALESCE(c.parent_id, t.category_id) = ${TRANSFER_CAT}`;

export async function categorizeTransfers(env: Env, limit = 8): Promise<{ categorized: number; remaining: number }> {
  const rows = await env.DB.prepare(`${TRANSFER_TARGET} ORDER BY t.time DESC LIMIT ?`).bind(limit).all<TxRow>();

  let categorized = 0;
  for (const tx of rows.results ?? []) {
    try { await categorizeTransferOne(env, tx); categorized++; }
    catch { /* skip this one, continue the batch */ }
  }

  const rest = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (${TRANSFER_TARGET})`,
  ).first<{ n: number }>();

  return { categorized, remaining: rest?.n ?? 0 };
}

export async function transfersPending(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${TRANSFER_TARGET})`).first<{ n: number }>();
  return r?.n ?? 0;
}

// §R2-ST4: інтерактивне рев'ю. Проганяє AI по батчу нерозмічених переказів, ЗБЕРІГАЄ
// пропозицію (щоб не платити двічі), але ПОВЕРТАЄ список для перегляду/правки користувачем.
// needs_attention: AI не визначив (null) або сам невпевнений (confidence='low').
export interface TransferReviewRow {
  id: string; merchant: string | null; comment: string | null; amount: number; currency_code: number; time: number;
  real_category_id: number | null; note: string | null; needs_attention: boolean;
}

async function reviewTransferOne(env: Env, tx: TxRow, hint?: string | null): Promise<TransferReviewRow> {
  // З підказкою користувача завжди перепрогонюємо через AI (не беремо навчене), щоб врахувати уточнення.
  if (!hint) {
    const learned = await learnedRealCategory(env, tx);
    if (learned !== undefined) {
      await env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?").bind(learned, tx.id).run();
      return {
        id: tx.id, merchant: tx.merchant, comment: tx.comment, amount: tx.amount,
        currency_code: tx.currency_code, time: tx.time,
        real_category_id: learned, note: null, needs_attention: learned == null,
      };
    }
  }

  const history = await realCategoryHistory(env, tx);
  // Рев'ю — user-facing, тож розумніша модель (Sonnet 5).
  const { result, usage } = await proposeTransferCategory(env, {
    merchant: tx.merchant, comment: tx.comment, mcc: tx.mcc,
    amount: tx.amount, currency_code: tx.currency_code, history, hint: hint ?? null,
  }, MODEL_SMART);
  logUsage("transfer-cat", usage);
  await env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?")
    .bind(result.real_category_id ?? null, tx.id).run();

  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
  if (tx.source === "mono" && rawDesc && result.real_category_id != null) {
    await env.DB.prepare(
      "UPDATE merchant_aliases SET real_category_id = ? WHERE match_type = 'mono_desc' AND raw_key = ?",
    ).bind(result.real_category_id, rawDesc).run();
  }

  return {
    id: tx.id, merchant: tx.merchant, comment: tx.comment, amount: tx.amount,
    currency_code: tx.currency_code, time: tx.time,
    real_category_id: result.real_category_id ?? null, note: result.note ?? null,
    needs_attention: result.real_category_id == null || result.confidence === "low",
  };
}

export async function reviewTransfers(env: Env, limit = 12): Promise<{ rows: TransferReviewRow[]; remaining: number }> {
  const rows = await env.DB.prepare(`${TRANSFER_TARGET} ORDER BY t.time DESC LIMIT ?`).bind(limit).all<TxRow>();
  const out: TransferReviewRow[] = [];
  for (const tx of rows.results ?? []) {
    try { out.push(await reviewTransferOne(env, tx)); }
    catch { /* skip this one */ }
  }
  const rest = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${TRANSFER_TARGET})`).first<{ n: number }>();
  return { rows: out, remaining: rest?.n ?? 0 };
}

// §C2: перепрогнати ОДИН переказ через AI з підказкою користувача («описати для AI»).
export async function reviewTransferWithHint(env: Env, id: string, hint: string): Promise<TransferReviewRow | null> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<TxRow>();
  if (!tx) return null;
  return reviewTransferOne(env, tx, hint.trim() || null);
}
