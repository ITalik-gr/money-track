// AI-збагачення транзакцій (гібрид). Застосовує результат Haiku до транзакції,
// вчить merchant_alias по сирому опису (повтори застосуються без AI), проставляє
// теги (вторинні категорії) і прапорець переказу для kind transfer/withdrawal.
import type { Env } from "../env.ts";
import { MODEL_SMART, enrichTransaction, proposeTransferCategory, logUsage } from "./ai.ts";
import { getState } from "./repo.ts";
import { relatedSubsHint, matchActiveSubscription } from "./subscriptions.ts";

// Seeded id категорії «Перекази і зняття» (0002). Її діти теж рахуємо через COALESCE(parent_id).
export const TRANSFER_CAT = 13;

interface TxRow {
  id: string; account_id: string; source: string; merchant: string | null;
  comment: string | null; mcc: number | null; amount: number; currency_code: number;
  raw_json: string | null; user_note: string | null; category_id: number | null;
  time: number;
}

// §R6 Консенсус мерчанта (детерміністично, без AI): нормалізований «корінь» назви з
// сирого опису — стабільний ключ, що терпить змінні хвости (номери замовлень, міста).
// Беремо найдовше буквене слово ≥4 символів (Apple, Glovo, Aromakava...).
function coreToken(raw: string | null): string | null {
  if (!raw) return null;
  const words = raw.toLowerCase()
    .replace(/[^a-zа-яїієґ0-9]+/gi, " ")
    .split(" ")
    .filter((w) => /[a-zа-яїієґ]/i.test(w) && w.length >= 4);
  if (!words.length) return null;
  return words.sort((a, b) => b.length - a.length)[0];
}

// §Хвіст: чи існує РУЧНИЙ (навчений користувачем) alias для сирого опису цієї операції.
// Ручні правки священні: enrich їх не перетирає, консенсус важить вище.
async function manualAliasFor(env: Env, rawDesc: string | null): Promise<boolean> {
  if (!rawDesc) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ? AND source = 'manual' LIMIT 1",
  ).bind(rawDesc).first<{ x: number }>();
  return !!row;
}

// Записати/оновити навчений alias по сирому опису — але НІКОЛИ не перетерти ручний (source='manual').
// Нові записи від AI позначаємо source='ai'.
async function writeAiAlias(
  env: Env,
  rawDesc: string,
  displayName: string | null,
  categoryId: number | null,
  isTransfer: number,
): Promise<void> {
  if (await manualAliasFor(env, rawDesc)) return; // ручну правку не чіпаємо
  await env.DB.prepare("DELETE FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ?").bind(rawDesc).run();
  await env.DB.prepare(
    `INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, is_transfer, source, created_at)
     VALUES ('mono_desc', ?, ?, ?, ?, 'ai', ?)`,
  ).bind(rawDesc, displayName, categoryId, isTransfer, Math.floor(Date.now() / 1000)).run();
}

// Якщо той самий мерчант (за коренем) історично ≥3× потрапляв домінантно (≥80%) в одну
// категорію — застосовуємо її без AI. §Хвіст: ручні правки важать ×3 (вага замість COUNT),
// тож одне явне рішення користувача переважує кілька авто-класифікацій.
// Повертає {category_id, merchant, n} або null (n = зважений голос).
async function consensusCategory(
  env: Env,
  tx: TxRow,
): Promise<{ category_id: number; merchant: string | null; n: number } | null> {
  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description ?? null : null;
  const token = coreToken(rawDesc ?? tx.merchant);
  if (!token) return null;
  const rows = await env.DB.prepare(
    `SELECT t.category_id AS cat, t.merchant AS merchant,
            SUM(CASE WHEN ma.id IS NOT NULL THEN 3 ELSE 1 END) AS n
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN merchant_aliases ma ON ma.match_type = 'mono_desc' AND ma.source = 'manual'
            AND ma.raw_key = json_extract(t.raw_json, '$.description')
     WHERE t.id != ? AND t.category_id IS NOT NULL AND t.is_transfer = 0
       AND COALESCE(c.parent_id, t.category_id) != ${TRANSFER_CAT}
       AND (LOWER(t.merchant) LIKE ? OR LOWER(json_extract(t.raw_json, '$.description')) LIKE ?)
     GROUP BY t.category_id, t.merchant`,
  ).bind(tx.id, `%${token}%`, `%${token}%`).all<{ cat: number; merchant: string | null; n: number }>();
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
async function merchantHistory(env: Env, tx: TxRow): Promise<string | null> {
  if (!tx.merchant) return null;
  const row = await env.DB.prepare(
    `SELECT c.name AS name, COUNT(*) AS n
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE t.merchant = ? AND t.id != ? AND t.category_id IS NOT NULL
     GROUP BY t.category_id ORDER BY n DESC LIMIT 1`,
  ).bind(tx.merchant, tx.id).first<{ name: string; n: number }>();
  return row ? `раніше «${tx.merchant}» відносили до «${row.name}» (${row.n}×)` : null;
}

async function applyEnrichment(
  env: Env,
  tx: TxRow,
  profile?: string | null,
  opts: { consensus?: boolean } = {},
): Promise<void> {
  // §Хвіст: авто-ре-світ НІКОЛИ не чіпає операцію із захищеною ручною правкою
  // (manual alias). Явна «Розпізнати» (force → consensus:false) — свідома дія, дозволяємо.
  const rawDescGuard = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() ?? null : null;
  if (opts.consensus !== false && (await manualAliasFor(env, rawDescGuard))) return;

  // §R6: спершу — консенсус мерчанта (без AI). На авто-шляху економить виклик; ручна
  // «Розпізнати» передає consensus:false, щоб завжди питати AI (напр. виправити помилку).
  if (opts.consensus !== false) {
    const hit = await consensusCategory(env, tx);
    if (hit) {
      const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
      const name = hit.merchant ?? tx.merchant;
      // §R7: якщо назву зафіксовано вручну (name_locked) — не перетираємо мерчант, лише категорію.
      await env.DB.prepare(
        "UPDATE transactions SET merchant = CASE WHEN name_locked = 1 THEN merchant ELSE ? END, category_id = ?, ai_note = ?, ai_enriched = 1 WHERE id = ?",
      ).bind(name, hit.category_id, `категорію визначено за історією (${hit.n}× той самий мерчант)`, tx.id).run();
      // Навчаємо alias на точному сирому описі — наступний ідентичний піде миттєво (не чіпаючи ручні).
      if (tx.source === "mono" && rawDesc) await writeAiAlias(env, rawDesc, name, hit.category_id, 0);
      return;
    }
  }

  const history = await merchantHistory(env, tx);
  // §R2-TX3: даємо AI явну вказівку користувача (нотатку) + поточну категорію, щоб
  // він пріоритезував їх, а не перетирав вручну обране на «Інше».
  let currentCategory: string | null = null;
  if (tx.category_id != null) {
    const c = await env.DB.prepare("SELECT name FROM categories WHERE id = ?")
      .bind(tx.category_id).first<{ name: string }>();
    currentCategory = c?.name ?? null;
  }
  // Підказка про підписки зі схожою назвою (порожня, якщо жодна не перегукується — тоді
  // зайвих токенів AI не отримує, вартість лишається рівною).
  const rawDescForSub = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description ?? null : null;
  const subscriptions = await relatedSubsHint(env.DB, { merchant: tx.merchant, description: rawDescForSub });

  const { result, usage } = await enrichTransaction(env, {
    merchant: tx.merchant, comment: tx.comment, mcc: tx.mcc,
    amount: tx.amount, currency_code: tx.currency_code, history,
    user_note: tx.user_note, current_category: currentCategory,
    profile: profile ?? null, subscriptions,
  });
  logUsage("enrich", usage);

  const isTransfer = result.kind === "transfer" || result.kind === "withdrawal" ? 1 : 0;
  const cleanName = result.clean_name?.trim() || tx.merchant;

  // §R5: після очищення назви ще раз пробуємо детермінований матч підписки (раптом сира
  // назва не збіглась, а людська — так) → лінк tx↔підписка + її категорія має пріоритет.
  const sub = tx.amount < 0
    ? await matchActiveSubscription(env.DB, {
        merchant: cleanName, description: rawDescForSub, amount: tx.amount, currency_code: tx.currency_code,
      })
    : null;
  const finalCategory = sub?.category_id ?? result.category_id ?? null;

  // §R7: name_locked → зберігаємо ручну назву (AI уточнює лише категорію/переказ/note).
  await env.DB.prepare(
    "UPDATE transactions SET merchant = CASE WHEN name_locked = 1 THEN merchant ELSE ? END, category_id = COALESCE(?, category_id), is_transfer = ?, ai_note = ?, planned_id = COALESCE(?, planned_id), ai_enriched = 1 WHERE id = ?",
  ).bind(cleanName, finalCategory, isTransfer, result.note?.trim() || null, sub?.planned_id ?? null, tx.id).run();

  // Теги (вторинні категорії), до 3, без дублю основної.
  const tags = (result.tag_ids ?? []).filter((t) => t && t !== result.category_id).slice(0, 3);
  for (const t of tags) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO transaction_tags (transaction_id, category_id) VALUES (?, ?)",
    ).bind(tx.id, t).run();
  }

  // Навчання: сирий опис від моно → людська назва + категорія + прапорець переказу.
  // Idempotent + §Хвіст: writeAiAlias не перетирає ручний alias і позначає запис source='ai'.
  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
  if (tx.source === "mono" && rawDesc) {
    await writeAiAlias(env, rawDesc, cleanName, result.category_id ?? null, isTransfer);
  }
}

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
  return row ? `раніше схожий переказ «${tx.merchant}» відносили до «${row.name}» (${row.n}×)` : null;
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

async function categorizeTransferOne(env: Env, tx: TxRow): Promise<void> {
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

// force=true (ручна «Розпізнати») завжди питає AI; авто-шлях (вебхук) дозволяє консенсус.
export async function enrichOne(env: Env, id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<TxRow>();
  if (!tx) return false;
  const profile = await getState(env.DB, "finance_profile");
  await applyEnrichment(env, tx, profile, { consensus: !opts.force });

  // Якщо після збагачення операція опинилась у бакеті «Перекази і зняття» без реальної
  // категорії — одразу підкажемо, на що кошти пішли (щоб кнопка «Розпізнати» була цілісною).
  const after = await env.DB.prepare(
    `SELECT t.* FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id = ? AND t.is_transfer = 0 AND t.amount < 0 AND t.real_category_id IS NULL
       AND COALESCE(c.parent_id, t.category_id) = ${TRANSFER_CAT}`,
  ).bind(id).first<TxRow>();
  if (after) { try { await categorizeTransferOne(env, after); } catch { /* best-effort */ } }
  return true;
}

// Масове збагачення нерозпізнаних (без категорії, ще не пройдених AI). Обробляє
// невеликий батч за виклик; клієнт повторює, поки remaining > 0.
export async function enrichPending(env: Env, limit = 8): Promise<{ enriched: number; remaining: number }> {
  const rows = await env.DB.prepare(
    `SELECT * FROM transactions
     WHERE source = 'mono' AND ai_enriched = 0 AND category_id IS NULL AND hold = 0
     ORDER BY time DESC LIMIT ?`,
  ).bind(limit).all<TxRow>();

  const profile = await getState(env.DB, "finance_profile");
  let enriched = 0;
  for (const tx of rows.results ?? []) {
    try { await applyEnrichment(env, tx, profile); enriched++; }
    catch { /* skip this one, continue the batch */ }
  }

  const rest = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE source = 'mono' AND ai_enriched = 0 AND category_id IS NULL AND hold = 0",
  ).first<{ n: number }>();

  return { enriched, remaining: rest?.n ?? 0 };
}
