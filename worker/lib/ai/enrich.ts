// AI-збагачення транзакцій (гібрид). Застосовує результат Haiku до транзакції,
// вчить merchant_alias по сирому опису (повтори застосуються без AI), проставляє
// теги (вторинні категорії) і прапорець переказу для kind transfer/withdrawal.
import type { Env } from "../../env.ts";
// The three model calls this file orchestrates now LIVE here (phase 5, L6): categorising one
// transaction, guessing the real category behind a withdrawal, and parsing free text into a
// record. They used to sit in `ai.ts` — see ARCHITECTURE.md §3 D3 on why that split had no rule.
import { callHaikuJson } from "./json.ts";
import { buildSystemPrefix, langNoteDirective } from "./prompt.ts";
import type { AnthropicUsage } from "./cost.ts";
import { logUsage } from "./cost.ts";

// Enrich a single transaction from its raw bank fields — understand what it actually
// is, pick a category, flag transfers/withdrawals, suggest secondary tags. Reuses the
// cached taxonomy prefix, so a batch of enrichments is cheap.
export interface EnrichResult {
  clean_name: string;      // людська назва замість сирого опису
  category_id: number | null;
  kind: "expense" | "income" | "transfer" | "withdrawal";
  tag_ids: number[];       // до 3 вторинних категорій-тегів (не сумуються)
  note: string | null;     // короткий здогад, що це, для контексту
  /** §AI-RECURRING — a subscription charge? The full reasoning is in migration 0046. */
  recurring?: boolean;
}

export async function enrichTransaction(
  env: Env,
  tx: {
    merchant: string | null; comment: string | null; mcc: number | null;
    amount: number; currency_code: number; history?: string | null;
    user_note?: string | null; current_category?: string | null; profile?: string | null;
    subscriptions?: string | null;
  },
): Promise<{ result: EnrichResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "work out what a bank transaction actually is from its raw fields and return JSON " +
      "{clean_name (the human-readable brand name), category_id (id of the main category, or null), " +
      // Промт цілком українською, тож модель за інерцією «олюднювала» латиницю в кирилицю:
      // «SILPO» приїжджало як «Силпо». Назва мерчанта — це ім'я власне й ключ, за яким
      // сходяться merchant_alias/консенсус/сторінка мерчанта, тож транслітерація ще й дробить
      // історію одного магазину на два різні написання.
      "⚠️ clean_name is a PROPER NOUN: keep the brand exactly as spelled in raw_description, do NOT transliterate " +
      "and do NOT translate it (SILPO → \"Silpo\", NOT \"Силпо\"; NOVUS → \"Novus\"). If the description already " +
      "spells the name in Cyrillic, leave it in Cyrillic. Strip only bank noise: terminal numbers, cities, codes. " +
      "kind ('expense'|'income'|'transfer'|'withdrawal'; transfer = a move between the user's own accounts or a " +
      "round-up, withdrawal = a cash withdrawal), tag_ids (an array of 0-3 secondary category ids), note (a short " +
      "guess, or null), recurring (true ONLY when the charge is clearly a payment for a RECURRING " +
      "service billed on a schedule — a streaming, software, cloud, mobile or gym subscription, a " +
      "membership, an insurance premium. false for a one-off purchase, groceries, a restaurant, " +
      "transport, a transfer, or a single app or game bought outright. When unsure, false: this " +
      "field creates a suggestion the user has to dismiss, and a wrong one costs more than a " +
      "missing one)}. " +
      "PRIORITY 1 — user_note: if the user stated outright what this is (\"this was leisure\", \"a gift\", \"this is " +
      "entertainment\", \"this is my salary\"), set exactly the category they mean, matching by meaning rather than " +
      "by exact wording (leisure or fun → the entertainment category, food → the groceries category, and so on). " +
      "PRIORITY 2 — current_category: if the user already picked a category by hand, do NOT overwrite it with the " +
      "catch-all \"other\" category without strong grounds in the fields; leave it, or refine within it. " +
      "INCOME (sign=income): an incoming transfer from a private individual — even with no shop and MCC 4829 — is NOT " +
      "automatically a gift. If the user says (in user_note or their profile) that this is their salary, earnings " +
      "or a withdrawal of their own money (e.g. moving a crypto salary out via P2P), set the salary category or the " +
      "matching income category, not the gift one. Use the gift category only when it genuinely looks like a gift " +
      "and nothing indicates otherwise. " +
      "If user_profile is present, it describes the user and their situation; use it as context (a freelancer, say, " +
      "will have charges that are taxes or work expenses). If merchant_history is present, the user has classified " +
      "this merchant before; agree with it unless it contradicts the above. If known_subscriptions is present, those " +
      "are recurring payments the user declared with a similar name; when an operation looks like a charge for one " +
      "of them, set exactly that category." +
      // §LANG (2026-08-08): `note` — ЄДИНЕ поле цього виводу, яке читає людина (воно лягає в
      // `transactions.ai_note` і показується в деталях операції). Решта — структура: id категорій,
      // `kind`, і `clean_name`, що є ІМЕНЕМ ВЛАСНИМ і не перекладається ніколи. Тому директива тут
      // адресна: без неї англомовний користувач бачив український коментар під кожною своєю
      // покупкою, тобто «застосунок англійською, а AI — ні».
      // ⚠️ Enrich іде з вебхука, де запиту (і заголовка мови) немає, тож він спирається на
      // збережену `app_state.locale` — саме її тепер проставляє клієнт при першому вході.
      (await langNoteDirective(env)),
    true, // §R6: вмикаємо детальний гайд (Spotify→Стрімінги тощо) + активує prompt-кеш для bulk-enrich.
  );
  const amountMajor = tx.amount / 100;
  const payload = {
    raw_description: tx.merchant,
    bank_comment: tx.comment,
    mcc: tx.mcc,
    amount: amountMajor,
    currency_code: tx.currency_code,
    sign: tx.amount < 0 ? "expense" : "income",
    merchant_history: tx.history ?? null,
    user_note: tx.user_note ?? null,
    current_category: tx.current_category ?? null,
    user_profile: tx.profile ?? null,
    known_subscriptions: tx.subscriptions ?? null,
  };
  // Модель за задачею (рішення користувача 2026-07-14): коли користувач САМ описав операцію
  // нотаткою (user_note) — беремо розумний Sonnet для розпізнання (він поважає пояснення й не
  // плутає «зарплату/вивід» з «подарунком»). Масовий/авто-enrich без нотатки лишається на дешевому Haiku.
  const model = tx.user_note?.trim() ? MODEL_SMART : MODEL_FAST;
  return callHaikuJson<EnrichResult>(env, system, [
    { type: "text", text: `Analyse the transaction and return JSON only:\n${JSON.stringify(payload)}` },
  ], 1024, model);
}

// §F2 крок 2: для операції у бакеті «Перекази і зняття» (зняття готівки, card-to-card)
// AI здогадується про РЕАЛЬНУ категорію витрати — на що ці кошти пішли насправді.
// Повертає real_category_id (id основної категорії) або null, якщо це справжній
// внутрішній рух власних коштів / визначити неможливо. Вторинну класифікацію лишаємо.
export interface TransferCategoryResult {
  real_category_id: number | null;
  note: string | null; // короткий здогад укр. або null
  confidence: "high" | "low"; // low → рядок «потребує уваги» в рев'ю (§R2-ST4)
}

export async function proposeTransferCategory(
  env: Env,
  tx: { merchant: string | null; comment: string | null; mcc: number | null; amount: number; currency_code: number; history?: string | null; hint?: string | null },
  model: string = MODEL_FAST,
): Promise<{ result: TransferCategoryResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "this operation is a transfer or a cash withdrawal. Work out the REAL spending category — what the money " +
      "actually went on (cash withdrawn → the most likely everyday category, such as groceries or the catch-all " +
      "\"other\"; a transfer to a specific service or person for goods or a service → the matching category). Return " +
      "JSON {real_category_id (id of the main expense category, or null), note (a short guess, or null), " +
      "confidence ('high' when you are sure; 'low' when this is more of a guess and the user is worth asking)}. " +
      "If this really is the user's own money moving between their own accounts or jars, or a round-up, then " +
      "real_category_id = null. " +
      "If user_hint is present, it is the user's own clarification about this very operation; trust it most. " +
      "If merchant_history is present, agree with it.",
  );
  const payload = {
    raw_description: tx.merchant,
    bank_comment: tx.comment,
    mcc: tx.mcc,
    amount: tx.amount / 100,
    currency_code: tx.currency_code,
    merchant_history: tx.history ?? null,
    user_hint: tx.hint ?? null,
  };
  return callHaikuJson<TransferCategoryResult>(env, system, [
    { type: "text", text: `Analyse the operation and return JSON only:\n${JSON.stringify(payload)}` },
  ], 1024, model);
}
import { MODEL_SMART, MODEL_FAST } from "./models.ts";
import { getState } from "../finance/repo.ts";
import { relatedSubsHint, matchActiveSubscription } from "../finance/subscriptions.ts";
import { coreToken } from "../finance/merchants.ts";

// Seeded id категорії «Перекази і зняття» (0002). Її діти теж рахуємо через COALESCE(parent_id).
export const TRANSFER_CAT = 13;

export interface TxRow {
  id: string; account_id: string; source: string; merchant: string | null;
  comment: string | null; mcc: number | null; amount: number; currency_code: number;
  raw_json: string | null; user_note: string | null; category_id: number | null;
  ai_note: string | null; time: number;   // §SUB-ALIAS: ai_note is part of the subscription haystack
}

// §R6 Консенсус мерчанта: нормалізований «корінь» назви з сирого опису — стабільний ключ, що
// терпить змінні хвости (номери замовлень, міста): найдовше буквене слово ≥4 символів.
// §Хвіст: чи існує РУЧНИЙ (навчений користувачем) alias для сирого опису цієї операції.
// Ручні правки священні: enrich їх не перетирає, консенсус важить вище.
async function manualAliasFor(env: Env, rawDesc: string | null): Promise<boolean> {
  if (!rawDesc) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ? AND source = 'manual' LIMIT 1",
  ).bind(rawDesc).first<{ x: number }>();
  return !!row;
}

// §FK-GUARD (2026-07-20): AI повертає id категорії, якого може не існувати.
// Категорій 45, але id доходять до 54 — у діапазоні є дірки від видалених, тож
// «правдоподібний» id від моделі влучає в неіснуючий рядок і будь-який запис
// (transactions.category_id / transaction_tags / merchant_aliases) валиться з
// `D1_ERROR: FOREIGN KEY constraint failed`, а користувач бачить лише «не вдалось».
// Правило: КОЖЕН id категорії, що прийшов від AI, проганяй через це перед записом.
async function existingCategoryIds(env: Env, ids: (number | null | undefined)[]): Promise<Set<number>> {
  const want = [...new Set(ids.filter((x): x is number => typeof x === "number" && Number.isFinite(x)))];
  if (!want.length) return new Set();
  const rows = await env.DB.prepare(
    `SELECT id FROM categories WHERE id IN (${want.map(() => "?").join(",")})`,
  ).bind(...want).all<{ id: number }>();
  return new Set((rows.results ?? []).map((r) => r.id));
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
  return row ? `"${tx.merchant}" was previously classified as "${row.name}" (${row.n}×)` : null;
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
      ).bind(name, hit.category_id, `category resolved from history (${hit.n}× the same merchant)`, tx.id).run();
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
  const subscriptions = await relatedSubsHint(env.DB, { merchant: tx.merchant, description: rawDescForSub, ai_note: tx.ai_note, comment: tx.comment });

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
  // ⚠️ §SUB-ALIAS: the note the model JUST wrote is part of the haystack — that is where the answer
  // lives when the biller's name and the user's differ («X Corp.» ↔ his Twitter subscription).
  const sub = tx.amount < 0
    ? await matchActiveSubscription(env.DB, {
        merchant: cleanName, description: rawDescForSub, amount: tx.amount,
        currency_code: tx.currency_code, ai_note: result.note ?? tx.ai_note, comment: tx.comment,
      })
    : null;
  // §FK-GUARD: перевіряємо ВСІ id від AI одним запитом. Категорія підписки (`sub`) —
  // з нашої ж БД, тож надійна; валідації потребує саме те, що вигадала модель.
  const aiIds = [result.category_id, ...(result.tag_ids ?? [])];
  const ok = await existingCategoryIds(env, aiIds);
  const aiCategory = result.category_id != null && ok.has(result.category_id) ? result.category_id : null;
  const finalCategory = sub?.category_id ?? aiCategory ?? null;

  // §R7: name_locked → зберігаємо ручну назву (AI уточнює лише категорію/переказ/note).
  await env.DB.prepare(
    "UPDATE transactions SET merchant = CASE WHEN name_locked = 1 THEN merchant ELSE ? END, category_id = COALESCE(?, category_id), is_transfer = ?, ai_note = ?, planned_id = COALESCE(?, planned_id), ai_recurring = ?, ai_enriched = 1 WHERE id = ?",
    // §AI-RECURRING: 0/1 once asked — "not asked" and "said no" mean different things downstream.
  ).bind(cleanName, finalCategory, isTransfer, result.note?.trim() || null, sub?.planned_id ?? null,
         result.recurring ? 1 : 0, tx.id).run();

  // Теги (вторинні категорії), до 3, без дублю основної. Неіснуючі id відкидаємо (§FK-GUARD).
  const tags = (result.tag_ids ?? []).filter((t) => t && t !== aiCategory && ok.has(t)).slice(0, 3);
  for (const t of tags) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO transaction_tags (transaction_id, category_id) VALUES (?, ?)",
    ).bind(tx.id, t).run();
  }

  // Навчання: сирий опис від моно → людська назва + категорія + прапорець переказу.
  // Idempotent + §Хвіст: writeAiAlias не перетирає ручний alias і позначає запис source='ai'.
  const rawDesc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
  if (tx.source === "mono" && rawDesc) {
    await writeAiAlias(env, rawDesc, cleanName, aiCategory, isTransfer); // §FK-GUARD: лише перевірений id
  }
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
  // §F2 step 2 lives in `transfers-ai.ts` now. Imported lazily HERE rather than at the top,
  // because that module imports this one: a static edge in both directions is the cycle the split
  // was made to avoid, and this is the only place the arrow points the other way.
  if (after) {
    try {
      const { categorizeTransferOne } = await import("./transfers-ai.ts");
      await categorizeTransferOne(env, after);
    } catch { /* best-effort */ }
  }
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
