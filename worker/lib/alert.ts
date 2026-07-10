// §F2 крок 2 (частина 2): пер-транзакційний TG-алерт. Коли приходить ВАГОМА операція,
// яку ми не можемо пояснити (непомічений переказ/зняття без реальної категорії, зовсім
// без категорії, або витрата, що переводить бюджет-конверт за ліміт), — надсилаємо її в
// Telegram із коротким AI-здогадом і кнопками, щоб швидко розмітити прямо з чату.
//
// Тригер — вебхук monobank (реальний час, best-effort у waitUntil) + ручний/крон-скан.
// Гейт — налаштовані TG-секрети. Дедуп — прапорець transactions.alerted (міграція 0010).
import type { Env } from "../env.ts";
import { sendMessage, type InlineKeyboard } from "./telegram.ts";
import { proposeTransferCategory, logUsage } from "./ai.ts";
import { TRANSFER_CAT } from "./enrich.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uah = (minor: number) => (minor / 100).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Поріг «вагомості» для непояснених операцій: не нижче FLOOR, і не нижче ~3× середньої
// витрати за 90 днів (щоб адаптуватись під масштаб трат конкретного користувача).
const SIGNIFICANT_FLOOR = 100_000;   // 1000 ₴
const SIGNIFICANT_MULT = 3;
const BUDGET_MIN_TX = 5_000;         // 50 ₴ — дрібніші не турбують навіть при перевищенні

interface AlertTx {
  id: string; account_id: string; amount: number; currency_code: number; hold: number;
  is_transfer: number; alerted: number; category_id: number | null; real_category_id: number | null;
  merchant: string | null; comment: string | null; mcc: number | null; raw_json: string | null;
  parent_id: number | null; category_name: string | null;
}

async function significanceThreshold(env: Env): Promise<number> {
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  const r = await env.DB.prepare(
    `SELECT AVG(-amount) AS avg FROM transactions
     WHERE time >= ? AND amount < 0 AND hold = 0 AND is_transfer = 0 AND currency_code = 980`,
  ).bind(since).first<{ avg: number | null }>();
  const avg = r?.avg ?? 0;
  return Math.max(SIGNIFICANT_FLOOR, Math.round(avg * SIGNIFICANT_MULT));
}

async function categoryName(env: Env, id: number | null): Promise<string | null> {
  if (id == null) return null;
  const r = await env.DB.prepare("SELECT name FROM categories WHERE id = ?").bind(id).first<{ name: string }>();
  return r?.name ?? null;
}

// Місячна витрата по (рол-ап) категорії + її ліміт, щоб зловити момент перетину.
async function budgetBreach(env: Env, rolledCat: number, outflow: number): Promise<{ name: string; spent: number; budget: number } | null> {
  const bud = await env.DB.prepare(
    "SELECT b.amount AS amount, c.name AS name FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.category_id = ? AND b.period = 'month' AND b.amount > 0",
  ).bind(rolledCat).first<{ amount: number; name: string }>();
  if (!bud) return null;
  const d = new Date();
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const sp = await env.DB.prepare(
    `SELECT COALESCE(SUM(-t.amount), 0) AS spent FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.time >= ? AND t.amount < 0 AND t.hold = 0 AND t.is_transfer = 0 AND t.currency_code = 980
       AND COALESCE(c.parent_id, t.category_id) = ?`,
  ).bind(monthStart, rolledCat).first<{ spent: number }>();
  const spentAfter = sp?.spent ?? 0;
  const spentBefore = spentAfter - outflow;
  // Алертимо лише момент перетину ліміту (раніше було під, тепер — за).
  if (spentBefore < bud.amount && spentAfter >= bud.amount) return { name: bud.name, spent: spentAfter, budget: bud.amount };
  return null;
}

function link(origin: string | undefined, id: string): string {
  return origin ? `\n\n🔗 <a href="${origin}/tx/${id}">відкрити у застосунку</a>` : "";
}

// Оцінити одну транзакцію й, за потреби, надіслати алерт. Ідемпотентно (alerted).
export async function maybeAlertTransaction(env: Env, txId: string, origin?: string): Promise<boolean> {
  const token = env.TG_BOT_TOKEN, chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return false;

  const tx = await env.DB.prepare(
    `SELECT t.*, c.parent_id AS parent_id, c.name AS category_name
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
  ).bind(txId).first<AlertTx>();
  if (!tx) return false;
  // Тільки проведені витрати у ₴, не внутрішні перекази, ще не алерчені.
  if (tx.hold || tx.alerted || tx.amount >= 0 || tx.is_transfer || tx.currency_code !== 980) return false;

  const outflow = -tx.amount;
  const rolled = tx.parent_id ?? tx.category_id;
  const isTransferBucket = rolled === TRANSFER_CAT;
  const threshold = await significanceThreshold(env);

  let text: string;
  let keyboard: InlineKeyboard;

  if (isTransferBucket && tx.real_category_id == null && outflow >= threshold) {
    // Непояснений переказ/зняття — AI-здогад про реальну категорію.
    let guessId: number | null = null, note: string | null = null;
    if (env.ANTHROPIC_API_KEY) {
      try {
        const { result, usage } = await proposeTransferCategory(env, {
          merchant: tx.merchant, comment: tx.comment, mcc: tx.mcc, amount: tx.amount, currency_code: tx.currency_code,
        });
        logUsage("alert", usage);
        guessId = result.real_category_id ?? null; note = result.note;
      } catch { /* AI best-effort */ }
    }
    const guessName = await categoryName(env, guessId);
    text =
      "🔎 <b>Вагома непояснена операція</b>\n\n" +
      `<b>${esc(tx.merchant ?? tx.comment ?? "—")}</b> — <b>${uah(outflow)} ₴</b>\n` +
      "Це переказ/зняття. На що ці кошти пішли насправді?" +
      (note ? `\n💡 ${esc(note)}` : "") + link(origin, tx.id);
    const rows: InlineKeyboard = [];
    if (guessId && guessName) rows.push([{ text: `✅ ${guessName}`, callback_data: `al_setreal:${tx.id}:${guessId}` }]);
    rows.push([{ text: "🏷 Інша категорія", callback_data: `al_cat:${tx.id}:real` }]);
    rows.push([{ text: "🔁 Переказ між своїми", callback_data: `al_transfer:${tx.id}` }, { text: "👌 Все ок", callback_data: `al_ok:${tx.id}` }]);
    keyboard = rows;
  } else if (tx.category_id == null && outflow >= threshold) {
    // Зовсім без категорії — попросимо розмітити.
    text =
      "🔎 <b>Вагома витрата без категорії</b>\n\n" +
      `<b>${esc(tx.merchant ?? tx.comment ?? "—")}</b> — <b>${uah(outflow)} ₴</b>\n` +
      "Не зміг визначити категорію." + link(origin, tx.id);
    keyboard = [
      [{ text: "🏷 Вказати категорію", callback_data: `al_cat:${tx.id}:cat` }],
      [{ text: "👌 Все ок", callback_data: `al_ok:${tx.id}` }],
    ];
  } else if (rolled != null && outflow >= BUDGET_MIN_TX) {
    const breach = await budgetBreach(env, rolled, outflow);
    if (!breach) return false;
    const pct = Math.round((breach.spent / breach.budget) * 100);
    text =
      "⚠️ <b>Бюджет перевищено</b>\n\n" +
      `<b>${esc(breach.name)}</b> — ${uah(breach.spent)} / ${uah(breach.budget)} ₴ (${pct}%)\n` +
      `Остання: ${esc(tx.merchant ?? tx.comment ?? "—")} — ${uah(outflow)} ₴.` + link(origin, tx.id);
    keyboard = [[{ text: "👌 Зрозумів", callback_data: `al_ok:${tx.id}` }]];
  } else {
    return false;
  }

  try {
    await sendMessage(token, chatId, text, keyboard);
  } catch { /* мережа/telegram best-effort */ }
  // Позначаємо алерченою у будь-якому разі — щоб не спамити повторами.
  await env.DB.prepare("UPDATE transactions SET alerted = 1 WHERE id = ?").bind(tx.id).run();
  return true;
}

// Скан останніх непроалерчених витрат (ручний тест із Налаштувань / крон-фолбек).
// Обмежуємо кількістю, щоб не завалити чат.
export async function scanAlerts(env: Env, origin?: string, max = 5): Promise<{ sent: number }> {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return { sent: 0 };
  const since = Math.floor(Date.now() / 1000) - 14 * 86400;
  const rows = await env.DB.prepare(
    `SELECT id FROM transactions
     WHERE time >= ? AND amount < 0 AND hold = 0 AND is_transfer = 0 AND alerted = 0 AND currency_code = 980
     ORDER BY time DESC LIMIT 100`,
  ).bind(since).all<{ id: string }>();
  let sent = 0;
  for (const r of rows.results ?? []) {
    if (sent >= max) break;
    try { if (await maybeAlertTransaction(env, r.id, origin)) sent++; } catch { /* continue */ }
  }
  return { sent };
}

// ---- дії з алерт-кнопок (навчання таке саме, як у PATCH /transactions/:id) --------

function rawDescOf(raw: string | null): string | null {
  if (!raw) return null;
  try { return (JSON.parse(raw) as { description?: string }).description?.trim() ?? null; } catch { return null; }
}

// Встановити реальну категорію переказу + навчити alias (back-apply до схожих).
export async function applyAlertRealCategory(env: Env, txId: string, catId: number | null): Promise<void> {
  await env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?").bind(catId, txId).run();
  const tx = await env.DB.prepare("SELECT source, raw_json FROM transactions WHERE id = ?").bind(txId)
    .first<{ source: string; raw_json: string | null }>();
  const rawKey = tx?.source === "mono" ? rawDescOf(tx.raw_json) : null;
  if (rawKey && catId != null) {
    await env.DB.prepare("UPDATE merchant_aliases SET real_category_id = ? WHERE match_type = 'mono_desc' AND raw_key = ?")
      .bind(catId, rawKey).run();
    await env.DB.prepare(
      `UPDATE transactions SET real_category_id = COALESCE(real_category_id, ?)
       WHERE source = 'mono' AND json_extract(raw_json, '$.description') = ?`,
    ).bind(catId, rawKey).run();
  }
}

// Встановити основну категорію (для операції без категорії) + навчити alias.
export async function applyAlertCategory(env: Env, txId: string, catId: number | null): Promise<void> {
  await env.DB.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").bind(catId, txId).run();
  const tx = await env.DB.prepare("SELECT source, raw_json FROM transactions WHERE id = ?").bind(txId)
    .first<{ source: string; raw_json: string | null }>();
  const rawKey = tx?.source === "mono" ? rawDescOf(tx.raw_json) : null;
  if (rawKey) {
    await env.DB.prepare("DELETE FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ?").bind(rawKey).run();
    await env.DB.prepare(
      `INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, is_transfer, created_at)
       VALUES ('mono_desc', ?, NULL, ?, 0, ?)`,
    ).bind(rawKey, catId, Math.floor(Date.now() / 1000)).run();
    await env.DB.prepare(
      `UPDATE transactions SET category_id = COALESCE(category_id, ?)
       WHERE source = 'mono' AND json_extract(raw_json, '$.description') = ? AND category_id IS NULL`,
    ).bind(catId, rawKey).run();
  }
}

export async function applyAlertTransfer(env: Env, txId: string): Promise<void> {
  await env.DB.prepare("UPDATE transactions SET is_transfer = 1 WHERE id = ?").bind(txId).run();
}
