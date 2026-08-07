// Telegram-бот (§ROADMAP 1). Той самий Worker: секретний сегмент шляху /tg/<TG_SECRET>
// + перевірка заголовка X-Telegram-Bot-Api-Secret-Token + allowlist одного chat_id
// (TG_CHAT_ID). Дані чутливі — «сліпі» сторонні апдейти ніколи не обробляються.
//
// Фаза 1 (MVP): /start /help /balance /last, вільний текст = швидкий ввід витрати
// з inline-підтвердженням, фото чека. Уся бізнес-логіка — зі спільних lib/ (finance,
// receipt, ai), щоб TG і HTTP-API робили однакове.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { getState, setState } from "../lib/finance/repo.ts";
import { computeSummary, createCashTx, recentTransactions, type Summary } from "../lib/finance/finance.ts";
import { ingestReceipt } from "../lib/ai/receipt.ts";
import { parseText } from "../lib/ai/enrich.ts";
import type { ChatMsg } from "../lib/ai/ai.ts";
import type { AiFact } from "../lib/ai/tasks.ts";
import { buildAndStoreInsight, getStoredInsight } from "../lib/ai/insight.ts";
import { buildAdvice, chatReply, getStoredAdvice } from "../lib/ai/advisor.ts";
import {
  answerCallbackQuery, editMessageText, getFileBytes, sendChatAction, sendMessage,
  type InlineKeyboard, type TgUpdate,
} from "../lib/messaging/telegram.ts";
import { applyAlertRealCategory, applyAlertCategory, applyAlertTransfer } from "../lib/messaging/alert.ts";

export const telegram = new Hono<{ Bindings: Env }>();

const HELP =
  "<b>Money Track</b> — фінтрекер у Telegram.\n\n" +
  "• <b>Напиши витрату текстом</b> — напр. «кава 45 аромакава» — я розберу й запропоную зберегти.\n" +
  "• <b>Надішли фото чека</b> — розпізнаю магазин, суму й позиції.\n\n" +
  "Команди:\n" +
  "/balance — власні кошти\n" +
  "/last — останні транзакції\n" +
  "/insight — тижневий AI-інсайт\n" +
  "/advice — фінансові поради\n" +
  "/ask &lt;питання&gt; — спитати AI-порадника\n" +
  "/help — ця довідка";

const SIGN: Record<number, string> = { 980: "₴", 840: "$", 978: "€" };
function money(minor: number, currency = 980): string {
  const v = (minor / 100).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v} ${SIGN[currency] ?? currency}`;
}

interface Pending {
  merchant: string;
  amount: number;       // major units, positive
  currency_code: number;
  category_id: number | null;
  note: string | null;
  message_id: number;
}

const pendingKey = (chatId: number) => `tg_pending_${chatId}`;
const currencyCode = (c: string): number => (c === "USD" ? 840 : c === "EUR" ? 978 : 980);

function balanceText(s: Summary): string {
  const lines = [`<b>Власні кошти:</b> ≈ ${money(s.totalUAH)}`];
  if (s.byCurrency.length > 1) {
    for (const b of s.byCurrency) lines.push(`  • ${money(b.own, b.currency_code)}`);
  }
  if (s.credit) lines.push(`\nКредитний ліміт: ${money(s.credit.limit)} — не рахую як свої.`);
  return lines.join("\n");
}

function confirmText(p: Pending, categoryName: string | null): string {
  return (
    "Розпізнав витрату:\n\n" +
    `<b>${escapeHtml(p.merchant || "—")}</b>\n` +
    `Сума: <b>${money(Math.round(p.amount * 100), p.currency_code)}</b>\n` +
    `Категорія: ${categoryName ? escapeHtml(categoryName) : "— без категорії"}` +
    (p.note ? `\nНотатка: ${escapeHtml(p.note)}` : "")
  );
}

const confirmKeyboard: InlineKeyboard = [
  [{ text: "✅ Зберегти", callback_data: "tgsave" }, { text: "❌ Скасувати", callback_data: "tgcancel" }],
  [{ text: "✏️ Категорія", callback_data: "tgcat" }],
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function categoryName(env: Env, id: number | null): Promise<string | null> {
  if (id == null) return null;
  const r = await env.DB.prepare("SELECT name FROM categories WHERE id = ?").bind(id).first<{ name: string }>();
  return r?.name ?? null;
}

// Клавіатура вибору категорії: верхньорівневі витратні, по 2 в ряд + «без категорії».
async function categoryKeyboard(env: Env): Promise<InlineKeyboard> {
  const rows = await env.DB.prepare(
    "SELECT id, name FROM categories WHERE is_income = 0 AND parent_id IS NULL ORDER BY id LIMIT 20",
  ).all<{ id: number; name: string }>();
  const kb: InlineKeyboard = [];
  const cats = rows.results ?? [];
  for (let i = 0; i < cats.length; i += 2) {
    kb.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `tgsetcat:${c.id}` })));
  }
  kb.push([{ text: "— без категорії", callback_data: "tgsetcat:0" }]);
  return kb;
}

// ---- Phase 2: AI insight / advice / ask -------------------------------------

// Факти AI (amount — у грн major) у рядок з тоном-емодзі.
function renderFacts(facts: AiFact[]): string {
  return facts.map((f) => {
    const dot = f.tone === "pos" ? "🟢" : f.tone === "neg" ? "🔴" : "•";
    const parts = [escapeHtml(f.label)];
    if (f.amount != null) parts.push(`<b>${f.amount.toLocaleString("uk-UA")} ₴</b>`);
    if (f.category) parts.push(escapeHtml(f.category));
    if (f.delta_pct != null) parts.push(`${f.delta_pct > 0 ? "+" : ""}${f.delta_pct}%`);
    return `${dot} ${parts.join(" · ")}`;
  }).join("\n");
}

async function handleInsight(env: Env, chatId: number): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  await sendChatAction(token, chatId, "typing");
  let ins = await getStoredInsight(env);
  if ((!ins || ins.empty) && env.ANTHROPIC_API_KEY) {
    try { ins = await buildAndStoreInsight(env); } catch { /* fall through */ }
  }
  if (!ins || ins.empty) { await sendMessage(token, chatId, "Поки нема даних для інсайту."); return; }
  const s = ins.structured;
  const body = s
    ? `<b>${escapeHtml(s.headline)}</b>\n\n${renderFacts(s.facts)}${s.note ? `\n\n💡 ${escapeHtml(s.note)}` : ""}`
    : escapeHtml(ins.text);
  await sendMessage(token, chatId, "📊 " + body);
}

async function handleAdvice(env: Env, chatId: number): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  await sendChatAction(token, chatId, "typing");
  let adv = await getStoredAdvice(env);
  if (!adv && env.ANTHROPIC_API_KEY) {
    try { adv = await buildAdvice(env); } catch { /* fall through */ }
  }
  if (!adv) { await sendMessage(token, chatId, "Порад ще нема. Додай фінансову ситуацію у вебі й спробуй ще раз."); return; }
  const runway = adv.runway_months != null ? `⏳ Запасу на <b>${adv.runway_months} міс</b>\n` : "";
  const steps = (adv.suggestions ?? []).map((x, i) => `${i + 1}. <b>${escapeHtml(x.title)}</b>\n   ${escapeHtml(x.detail)}`).join("\n");
  await sendMessage(token, chatId, `${runway}${escapeHtml(adv.summary || adv.runway_comment)}\n\n${steps}`);
}

const chatHistKey = (chatId: number) => `tg_chat_${chatId}`;

async function handleAsk(env: Env, chatId: number, question: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!env.ANTHROPIC_API_KEY) { await sendMessage(token, chatId, "AI-ключ не налаштовано на сервері."); return; }
  if (!question.trim()) { await sendMessage(token, chatId, "Напиши питання після /ask, напр. «/ask на чому зекономити?»"); return; }

  const raw = await getState(env.DB, chatHistKey(chatId));
  const history: ChatMsg[] = raw ? JSON.parse(raw) : [];
  const messages: ChatMsg[] = [...history, { role: "user" as const, content: question.trim() }].slice(-8);

  await sendChatAction(token, chatId, "typing");
  try {
    const { reply } = await chatReply(env, messages);
    await sendMessage(token, chatId, escapeHtml(reply));
    // Зберігаємо останні ~8 ходів діалогу на цей chat_id.
    await setState(env.DB, chatHistKey(chatId), JSON.stringify([...messages, { role: "assistant" as const, content: reply }].slice(-8)));
  } catch {
    await sendMessage(token, chatId, "Не вдалося відповісти. Спробуй ще раз.");
  }
}

// ---- update handling --------------------------------------------------------

async function handleText(env: Env, chatId: number, text: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const cmd = text.trim().toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await sendMessage(token, chatId, HELP);
    return;
  }
  if (cmd === "/balance") {
    await sendMessage(token, chatId, balanceText(await computeSummary(env)));
    return;
  }
  if (cmd === "/last") {
    const rows = await recentTransactions(env.DB, 10);
    if (!rows.length) { await sendMessage(token, chatId, "Транзакцій ще немає."); return; }
    const body = rows.map((r) => {
      const emoji = r.is_transfer ? "🔁" : r.amount < 0 ? "🔴" : "🟢";
      const name = r.merchant || r.comment || r.category_name || "—";
      const date = new Date(r.time * 1000).toLocaleDateString("uk-UA", { day: "2-digit", month: "short" });
      return `${emoji} <b>${money(r.amount, r.currency_code)}</b> — ${escapeHtml(name)} <i>${date}</i>`;
    }).join("\n");
    await sendMessage(token, chatId, "<b>Останні:</b>\n" + body);
    return;
  }
  if (cmd === "/insight") { await handleInsight(env, chatId); return; }
  if (cmd === "/advice") { await handleAdvice(env, chatId); return; }
  if (cmd === "/ask" || cmd.startsWith("/ask ")) {
    await handleAsk(env, chatId, text.trim().slice(4));
    return;
  }

  // Вільний текст → швидкий ввід витрати через AI.
  if (!env.ANTHROPIC_API_KEY) {
    await sendMessage(token, chatId, "AI-ключ не налаштовано на сервері — швидкий ввід недоступний.");
    return;
  }
  await sendChatAction(token, chatId, "typing");
  let parsed;
  try {
    parsed = (await parseText(env, text)).result;
  } catch {
    await sendMessage(token, chatId, "Не вдалося розібрати. Спробуй напр. «таксі 120».");
    return;
  }
  const p: Pending = {
    merchant: parsed.merchant || text.trim(),
    amount: Math.abs(parsed.amount) || 0,
    currency_code: currencyCode(parsed.currency),
    category_id: parsed.category_guess,
    note: parsed.note,
    message_id: 0,
  };
  const sent = await sendMessage(token, chatId, confirmText(p, await categoryName(env, p.category_id)), confirmKeyboard);
  p.message_id = sent.message_id;
  await setState(env.DB, pendingKey(chatId), JSON.stringify(p));
}

async function handlePhoto(env: Env, chatId: number, fileId: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!env.ANTHROPIC_API_KEY) {
    await sendMessage(token, chatId, "AI-ключ не налаштовано — розбір чека недоступний.");
    return;
  }
  await sendChatAction(token, chatId, "typing");
  try {
    const { bytes, mediaType } = await getFileBytes(token, fileId);
    const out = await ingestReceipt(env, bytes, mediaType);
    const items = out.result.items.length
      ? "\n" + out.result.items.slice(0, 15).map((it) => `• ${escapeHtml(it.name)} — ${money(Math.round(it.price * 100), out.result.currency === "USD" ? 840 : out.result.currency === "EUR" ? 978 : 980)}`).join("\n")
      : "";
    const status = out.matched ? "✅ Причеплено до транзакції Monobank" : "💾 Створено готівкову витрату";
    await sendMessage(
      token, chatId,
      `<b>${escapeHtml(out.result.store || "Чек")}</b> — ${money(Math.round(out.result.total * 100))}\n${status}${items}`,
    );
  } catch {
    await sendMessage(token, chatId, "Не вдалося розпізнати чек. Спробуй чіткіше фото.");
  }
}

// Клавіатура вибору категорії для алерту: верхньорівневі витратні + «— пропустити».
// mode='real' → задаємо реальну категорію переказу; mode='cat' → основну категорію.
async function alertCategoryKeyboard(env: Env, txId: string, mode: "real" | "cat"): Promise<InlineKeyboard> {
  const rows = await env.DB.prepare(
    "SELECT id, name FROM categories WHERE is_income = 0 AND parent_id IS NULL AND id != 13 ORDER BY id LIMIT 20",
  ).all<{ id: number; name: string }>();
  const set = mode === "real" ? "al_setreal" : "al_setcat";
  const kb: InlineKeyboard = [];
  const cats = rows.results ?? [];
  for (let i = 0; i < cats.length; i += 2) {
    kb.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `${set}:${txId}:${c.id}` })));
  }
  kb.push([{ text: mode === "real" ? "— не визначено" : "— без категорії", callback_data: `${set}:${txId}:0` }]);
  return kb;
}

// Дії з кнопок пер-транзакційного алерту (§F2 крок 2). Немає pending-запису — свій потік.
async function handleAlertCallback(env: Env, chatId: number, messageId: number, cbId: string, data: string): Promise<boolean> {
  const token = env.TG_BOT_TOKEN;
  const parts = data.split(":");
  const prefix = parts[0];
  const txId = parts[1];
  if (!prefix.startsWith("al_") || !txId) return false;

  if (prefix === "al_ok") {
    await editMessageText(token, chatId, messageId, "👌 Гаразд, лишаю як є.");
    await answerCallbackQuery(token, cbId);
    return true;
  }
  if (prefix === "al_transfer") {
    await applyAlertTransfer(env, txId);
    await editMessageText(token, chatId, messageId, "🔁 Позначив переказом між своїми — прибрав зі статистики.");
    await answerCallbackQuery(token, cbId, "Готово");
    return true;
  }
  if (prefix === "al_cat") {
    const mode = parts[2] === "cat" ? "cat" : "real";
    await editMessageText(token, chatId, messageId, "Оберіть категорію:", await alertCategoryKeyboard(env, txId, mode));
    await answerCallbackQuery(token, cbId);
    return true;
  }
  if (prefix === "al_setreal" || prefix === "al_setcat") {
    const catId = Number(parts[2]) || 0;
    const resolved = catId === 0 ? null : catId;
    if (prefix === "al_setreal") await applyAlertRealCategory(env, txId, resolved);
    else await applyAlertCategory(env, txId, resolved);
    const name = await categoryName(env, resolved);
    const label = prefix === "al_setreal" ? "Реальна категорія" : "Категорія";
    await editMessageText(token, chatId, messageId, `✅ ${label}: <b>${escapeHtml(name ?? "— пропущено")}</b>`);
    await answerCallbackQuery(token, cbId, "Збережено");
    return true;
  }
  return false;
}

async function handleCallback(env: Env, chatId: number, messageId: number, cbId: string, data: string): Promise<void> {
  // Алерт-кнопки обробляємо першими — у них власний потік без pending-запису.
  if (data.startsWith("al_") && await handleAlertCallback(env, chatId, messageId, cbId, data)) return;

  const token = env.TG_BOT_TOKEN;
  const raw = await getState(env.DB, pendingKey(chatId));
  const p: Pending | null = raw ? JSON.parse(raw) : null;

  if (data === "tgcancel") {
    await setState(env.DB, pendingKey(chatId), "");
    await editMessageText(token, chatId, messageId, "Скасовано.");
    await answerCallbackQuery(token, cbId);
    return;
  }
  if (!p) {
    await answerCallbackQuery(token, cbId, "Немає активного запису.");
    await editMessageText(token, chatId, messageId, "Запис застарів — надішли витрату ще раз.");
    return;
  }

  if (data === "tgcat") {
    await editMessageText(token, chatId, messageId, confirmText(p, await categoryName(env, p.category_id)), await categoryKeyboard(env));
    await answerCallbackQuery(token, cbId);
    return;
  }
  if (data.startsWith("tgsetcat:")) {
    const id = Number(data.slice("tgsetcat:".length)) || 0;
    p.category_id = id === 0 ? null : id;
    await setState(env.DB, pendingKey(chatId), JSON.stringify(p));
    await editMessageText(token, chatId, messageId, confirmText(p, await categoryName(env, p.category_id)), confirmKeyboard);
    await answerCallbackQuery(token, cbId);
    return;
  }
  if (data === "tgsave") {
    await createCashTx(env.DB, {
      amount: -Math.round(p.amount * 100),
      currency_code: p.currency_code,
      merchant: p.merchant,
      category_id: p.category_id,
      user_note: p.note,
      source: "cash",
    });
    await setState(env.DB, pendingKey(chatId), "");
    await editMessageText(token, chatId, messageId, `✅ Збережено: <b>${escapeHtml(p.merchant)}</b> — ${money(Math.round(p.amount * 100), p.currency_code)}`);
    await answerCallbackQuery(token, cbId, "Збережено");
    return;
  }
  await answerCallbackQuery(token, cbId);
}

// ---- webhook route ----------------------------------------------------------

telegram.post("/:secret", async (c) => {
  // 1) секретний сегмент шляху, 2) заголовок від Telegram — обидва мають збігтися.
  if (!c.env.TG_SECRET || c.req.param("secret") !== c.env.TG_SECRET) return c.text("forbidden", 403);
  if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.TG_SECRET) return c.text("forbidden", 403);

  let update: TgUpdate;
  try { update = await c.req.json<TgUpdate>(); } catch { return c.text("bad json", 400); }

  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (!chatId) return c.text("ok", 200);

  // §D1 — `/start <токен>`: привʼязка чату до акаунта. Воркер уже перевірив підпис і
  // доставив апдейт САМЕ в цей обʼєкт (див. `/tg/*` в index.ts), тож тут лишається записати
  // chat_id. Це ЄДИНИЙ шлях, що виконується для ще не привʼязаного чату.
  const startPayload = update.message?.text?.match(/^\/start\s+(\S+)/)?.[1];
  if (startPayload) {
    const { linkTgChat } = await import("../lib/messaging/tg-target.ts");
    await linkTgChat(c.env, chatId);
    await sendMessage(c.env.TG_BOT_TOKEN, chatId, "✅ Чат підключено. Сюди приходитимуть важливі сповіщення.");
    return c.text("ok", 200);
  }

  // Allowlist: лише ВЛАСНИЙ привʼязаний чат цього обʼєкта. Будь-хто інший — тихо ігноруємо
  // (ack 200). Раніше звірка йшла з глобальним `TG_CHAT_ID`; тепер джерело те саме, що й для
  // вихідних пушів, тож «кому шлемо» і «кого слухаємо» не можуть розійтись.
  const { tgTarget } = await import("../lib/messaging/tg-target.ts");
  const target = await tgTarget(c.env);
  const allowed = target?.chatId;
  if (!allowed || String(chatId) !== allowed || (fromId != null && String(fromId) !== allowed)) {
    return c.text("ok", 200);
  }

  // Обробляємо у waitUntil, щоб одразу віддати 200 (Telegram не ретраїть).
  c.executionCtx.waitUntil((async () => {
    try {
      if (update.callback_query?.message && update.callback_query.data) {
        await handleCallback(c.env, chatId, update.callback_query.message.message_id, update.callback_query.id, update.callback_query.data);
      } else if (update.message?.photo?.length) {
        const largest = update.message.photo[update.message.photo.length - 1];
        await handlePhoto(c.env, chatId, largest.file_id);
      } else if (update.message?.text) {
        await handleText(c.env, chatId, update.message.text);
      }
    } catch (e) {
      try { await sendMessage(c.env.TG_BOT_TOKEN, chatId, "Сталася помилка. Спробуй ще раз."); } catch { /* ignore */ }
      console.log(`[tg] error: ${String(e)}`);
    }
  })());

  return c.text("ok", 200);
});
