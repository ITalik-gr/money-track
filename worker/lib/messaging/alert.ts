// §F2 крок 2 (частина 2): пер-транзакційний TG-алерт. Коли приходить ВАГОМА операція,
// яку ми не можемо пояснити (непомічений переказ/зняття без реальної категорії, зовсім
// без категорії, або витрата, що переводить бюджет-конверт за ліміт), — надсилаємо її в
// Telegram із коротким AI-здогадом і кнопками, щоб швидко розмітити прямо з чату.
//
// Тригер — вебхук monobank (реальний час, best-effort у waitUntil) + ручний/крон-скан.
// Гейт — налаштовані TG-секрети. Дедуп — прапорець transactions.alerted (міграція 0010).
import type { Env } from "../../env.ts";
import { sendMessage, type InlineKeyboard } from "./telegram.ts";
import { tgTarget } from "./tg-target.ts";
import { proposeTransferCategory } from "../ai/enrich.ts";
import { logUsage } from "../ai/cost.ts";
import { TRANSFER_CAT } from "../ai/enrich.ts";
import { valueMode } from "../finance/stats.ts";
import { budgetStatus } from "../finance/budgets.ts";
import { getRates, resolveBaseCurrency } from "../finance/money.ts";
import { escapeHtml as esc, tgMoney } from "./tg-format.ts";
import { st, resolveLocale, type ServerLocale } from "../platform/i18n.ts";



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

/**
 * Місячна витрата по (рол-ап) категорії + її ліміт, щоб зловити момент перетину.
 *
 * ⚠️ **The THIRD copy of «скільки зʼїдено з конверта», removed 2026-08-21.** The first two were
 * merged into `budgetStatus()` on 2026-07-31, after the owner found Telegram quoting a different
 * figure than the app; this one was in the same directory and was missed. Its private SQL had
 * every defect the canon exists to prevent, in the same words as the copy that was fixed:
 * `t.currency_code = 980` (so every foreign purchase was invisible), no split handling (a divided
 * expense counted at full value), no reimbursements, no refunds, and no §BUDGET-MEMORY carry — so
 * the "limit" it compared against was not the limit the Plan page shows.
 *
 * `budgetStatus` gives `spent` AFTER this transaction, so the crossing test subtracts the
 * outflow — the same before/after logic, now over a number that means what it says.
 */
async function budgetBreach(
  env: Env, rolledCat: number, outflow: number,
): Promise<{ name: string; spent: number; budget: number } | null> {
  // Cheap gate FIRST. `budgetStatus` is the canon and it is not free — five queries, one of them
  // `categoryMonthlyLevels` — and this runs on EVERY incoming webhook transaction over 50 ₴. Most
  // categories carry no envelope at all, so one indexed existence check keeps the hot path the
  // shape it was before the canon moved in here.
  const hasEnvelope = await env.DB.prepare(
    "SELECT 1 FROM budgets WHERE category_id = ? AND period = 'month' LIMIT 1",
  ).bind(rolledCat).first();
  if (!hasEnvelope) return null;

  const { mult } = valueMode(await getRates(env), null);
  const row = (await budgetStatus(env, mult)).find((b) => b.id === rolledCat);
  // §BUDGET-ZERO: a zero envelope is a real limit, and crossing it is exactly what it is for.
  if (!row || row.amount < 0) return null;
  const spentAfter = row.spent;
  const spentBefore = spentAfter - outflow;
  // Алертимо лише момент перетину ліміту (раніше було під, тепер — за).
  if (spentBefore < row.amount && spentAfter >= row.amount) {
    return { name: row.name, spent: spentAfter, budget: row.amount };
  }
  return null;
}

function link(origin: string | undefined, id: string, locale: ServerLocale): string {
  return origin ? `\n\n🔗 <a href="${origin}/tx/${id}">${st(locale, "tgOpenInApp")}</a>` : "";
}

// Оцінити одну транзакцію й, за потреби, надіслати алерт. Ідемпотентно (alerted).
export async function maybeAlertTransaction(env: Env, txId: string, origin?: string): Promise<boolean> {
  // §D1: the addressee is this user's OWN linked chat (`tgTarget`), not the global one. The
  // owner-only gate this replaces existed because `TG_CHAT_ID` is a single chat — the owner's —
  // while this code runs for every user's incoming transaction.
  const target = await tgTarget(env);
  if (!target) return false;
  const { token, chatId } = target;
  // §D1 + §LANG-ARCH: a push has no request behind it, so both the language and the display
  // currency come from the stored preference — the fallback branch `resolveLocale` is built for.
  const locale = await resolveLocale(env);
  const base = await resolveBaseCurrency(env);

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
      st(locale, "tgUnexplained") + "\n\n" +
      `<b>${esc(tx.merchant ?? tx.comment ?? "—")}</b> — <b>${tgMoney(outflow, base, locale)}</b>\n` +
      st(locale, "tgUnexplainedBody") +
      (note ? `\n💡 ${esc(note)}` : "") + link(origin, tx.id, locale);
    const rows: InlineKeyboard = [];
    if (guessId && guessName) rows.push([{ text: `✅ ${guessName}`, callback_data: `al_setreal:${tx.id}:${guessId}` }]);
    rows.push([{ text: st(locale, "tgBtnOtherCategory"), callback_data: `al_cat:${tx.id}:real` }]);
    rows.push([{ text: st(locale, "tgBtnOwnTransfer"), callback_data: `al_transfer:${tx.id}` }, { text: st(locale, "tgBtnOk"), callback_data: `al_ok:${tx.id}` }]);
    keyboard = rows;
  } else if (tx.category_id == null && outflow >= threshold) {
    // Зовсім без категорії — попросимо розмітити.
    text =
      st(locale, "tgNoCategory") + "\n\n" +
      `<b>${esc(tx.merchant ?? tx.comment ?? "—")}</b> — <b>${tgMoney(outflow, base, locale)}</b>\n` +
      st(locale, "tgNoCategoryBody") + link(origin, tx.id, locale);
    keyboard = [
      [{ text: st(locale, "tgBtnSetCategory"), callback_data: `al_cat:${tx.id}:cat` }],
      [{ text: st(locale, "tgBtnOk"), callback_data: `al_ok:${tx.id}` }],
    ];
  } else if (rolled != null && outflow >= BUDGET_MIN_TX) {
    const breach = await budgetBreach(env, rolled, outflow);
    if (!breach) return false;
    const pct = Math.round((breach.spent / breach.budget) * 100);
    text =
      st(locale, "tgBudgetOver") + "\n\n" +
      `<b>${esc(breach.name)}</b> — ${tgMoney(breach.spent, base, locale)} / ${tgMoney(breach.budget, base, locale)} (${pct}%)\n` +
      st(locale, "tgBudgetLast", {
        merchant: esc(tx.merchant ?? tx.comment ?? "—"), amount: tgMoney(outflow, base, locale),
      }) + link(origin, tx.id, locale);
    keyboard = [[{ text: st(locale, "tgBtnGot"), callback_data: `al_ok:${tx.id}` }]];
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
  if (!(await tgTarget(env))) return { sent: 0 }; // §D1: same addressee rule as maybeAlertTransaction
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
