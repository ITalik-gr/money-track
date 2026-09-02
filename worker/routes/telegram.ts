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
import { computeSummary, createCashTx, recentTransactions } from "../lib/finance/finance.ts";
import { parseText } from "../lib/ai/parse-text.ts";
import {
  answerCallbackQuery, editMessageText, sendChatAction, sendMessage, type TgUpdate,
} from "../lib/messaging/telegram.ts";
import { handleAlertCallback } from "../lib/messaging/tg-alert-buttons.ts";
import {
  handleInsight, handleAdvice, handleAsk, handleStats, handleBudget, handleSubs, handleGoals,
  handleNotify, handleMute, handleUnlink, handlePhoto,
} from "../lib/messaging/tg-commands.ts";
import { resolveBaseCurrency } from "../lib/finance/money.ts";
import { st, resolveLocale, type ServerLocale } from "../lib/platform/i18n.ts";
import {
  escapeHtml, tgMoney, replyKeyboard, buttonCommand, balanceText, lastTxText,
} from "../lib/messaging/tg-format.ts";
import {
  type Pending, pendingKey, currencyCode, confirmText, confirmKeyboard, categoryKeyboard,
  categoryName,
} from "../lib/messaging/tg-entry.ts";
import { ensureBotSurface, markKeyboardShown } from "../lib/messaging/tg-surface.ts";

export const telegram = new Hono<{ Bindings: Env }>();


/**
 * Locale + display currency for one bot reply.
 *
 * Resolved per handler rather than threaded from the webhook: both reads hit the object's own
 * SQLite, and a parameter that every function has to remember to pass is the thing that gets
 * forgotten by the next handler somebody adds. §LANG-ARCH — `resolveLocale` is the ONE resolver;
 * a bot has no request headers, so it lands on the stored preference, which is what that fallback
 * branch exists for.
 */
async function tgCtx(env: Env): Promise<{ locale: ServerLocale; base: number }> {
  const [locale, base] = await Promise.all([resolveLocale(env), resolveBaseCurrency(env)]);
  return { locale, base };
}


async function handleText(env: Env, chatId: number, text: string, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const { locale, base } = await tgCtx(env);

  /**
   * A button press arrives as ORDINARY TEXT — so it has to be translated back into a command
   * BEFORE anything else looks at the message.
   *
   * Below this line sit the question heuristic and the expense parser, and both would happily
   * accept «📊 Статистика»: the first as a question, the second as a purchase from a merchant of
   * that name. The order is the whole safety of the feature.
   */
  const asButton = buttonCommand(text);
  const cmd = asButton ?? text.trim().toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    // The strip is (re)attached here, which is the only moment it can be: Telegram keeps a reply
    // keyboard until a message replaces it, so /start and /help are what restore it after the
    // user has hidden it or reinstalled the app.
    await sendMessage(token, chatId, st(locale, "tgHelp"), undefined, replyKeyboard(locale));
    await markKeyboardShown(env, chatId);
    return;
  }
  if (cmd === "/balance") {
    await sendMessage(token, chatId, balanceText(await computeSummary(env), locale, base));
    return;
  }
  if (cmd === "/last") {
    const rows = await recentTransactions(env.DB, 10);
    if (!rows.length) { await sendMessage(token, chatId, st(locale, "tgNoTx")); return; }
    await sendMessage(token, chatId, st(locale, "tgLastHeader") + "\n" + lastTxText(rows, locale));
    return;
  }
  if (cmd === "/stats" || cmd.startsWith("/stats ")) { await handleStats(env, chatId, cmd.slice(6), origin); return; }
  if (cmd === "/budget") { await handleBudget(env, chatId, origin); return; }
  if (cmd === "/subs") { await handleSubs(env, chatId, origin); return; }
  if (cmd === "/goals") { await handleGoals(env, chatId, origin); return; }
  if (cmd === "/notify") { await handleNotify(env, chatId, origin); return; }
  if (cmd.startsWith("/mute")) { await handleMute(env, chatId, cmd.slice(5), false); return; }
  if (cmd.startsWith("/unmute")) { await handleMute(env, chatId, cmd.slice(7), true); return; }
  if (cmd === "/unlink") { await handleUnlink(env, chatId); return; }
  if (cmd === "/insight") { await handleInsight(env, chatId); return; }
  if (cmd === "/advice") { await handleAdvice(env, chatId); return; }
  if (cmd === "/ask" || cmd.startsWith("/ask ")) {
    await handleAsk(env, chatId, text.trim().slice(4));
    return;
  }

  /**
   * A button whose command lost its branch shows help — it is NOT parsed as an expense.
   *
   * `BUTTONS` in `tg-format.ts` is a map that can drift from the dispatch above (rename a label,
   * drop a command), and the cost of drift landing in the parser is a saved «purchase» from a
   * merchant called «🎯 Цілі». A guard here makes the drift visible instead of expensive.
   */
  if (asButton) {
    await sendMessage(token, chatId, st(locale, "tgHelp"), undefined, replyKeyboard(locale));
    return;
  }

  /**
   * A QUESTION goes to the adviser, not to the expense parser.
   *
   * Without this, «скільки я витратив на каву?» was parsed as a purchase from a merchant called
   * «скільки я витратив на каву» — the app answering a question by offering to record it.
   *
   * ⚠️ The word boundary is `(?:\s|$)`, not `\b`: `\b` is defined on ASCII word characters, so
   * after a Cyrillic word it does not match at all and «що з бюджетом» sailed straight into the
   * expense parser. Caught by the test below, which is why the pattern is pinned there too.
   * ⚠️ The test is a heuristic and it is allowed to be: guessing wrong costs an ANSWER instead of
   * a draft, and the draft was never saved without confirmation anyway. A model call to classify
   * every message would double the cost of quick entry to fix a mistake the reader can see and
   * correct in one more message.
   */
  if (/[?？]/.test(text) || /^(скільки|чому|коли|який|яка|шо|що|how|why|when|what|which|where)(?:\s|$)/i.test(text.trim())) {
    await handleAsk(env, chatId, text.trim());
    return;
  }

  // Вільний текст → швидкий ввід витрати через AI.
  if (!env.ANTHROPIC_API_KEY) {
    await sendMessage(token, chatId, st(locale, "tgNoAiKeyQuick"));
    return;
  }
  await sendChatAction(token, chatId, "typing");
  let parsed;
  try {
    parsed = (await parseText(env, text)).result;
  } catch {
    await sendMessage(token, chatId, st(locale, "tgParseFailed"));
    return;
  }
  const p: Pending = {
    merchant: parsed.merchant || text.trim(),
    amount: Math.abs(parsed.amount) || 0,
    kind: parsed.kind === "income" ? "income" : "expense",
    currency_code: currencyCode(parsed.currency),
    category_id: parsed.category_guess,
    note: parsed.note,
    message_id: 0,
  };
  const sent = await sendMessage(token, chatId, confirmText(p, await categoryName(env, p.category_id), locale), confirmKeyboard(locale));
  p.message_id = sent.message_id;
  await setState(env.DB, pendingKey(chatId), JSON.stringify(p));
}


// Клавіатура вибору категорії для алерту: верхньорівневі витратні + «— пропустити».
// mode='real' → задаємо реальну категорію переказу; mode='cat' → основну категорію.
async function handleCallback(env: Env, chatId: number, messageId: number, cbId: string, data: string): Promise<void> {
  // Алерт-кнопки обробляємо першими — у них власний потік без pending-запису.
  if (data.startsWith("al_") && await handleAlertCallback(env, chatId, messageId, cbId, data)) return;
  // §TG-CSV: statement import has its own pending record (`tg_import:`), separate from the quick
  // entry below — a half-answered import must not be cancelled by typing an expense.
  if (data.startsWith("imp_")) {
    const { handleImportCallback } = await import("../lib/messaging/tg-import.ts");
    if (await handleImportCallback(env, chatId, messageId, cbId, data)) return;
  }

  const token = env.TG_BOT_TOKEN;
  const { locale } = await tgCtx(env);
  const raw = await getState(env.DB, pendingKey(chatId));
  const p: Pending | null = raw ? JSON.parse(raw) : null;

  if (data === "tgcancel") {
    await setState(env.DB, pendingKey(chatId), "");
    await editMessageText(token, chatId, messageId, st(locale, "tgCancelled"));
    await answerCallbackQuery(token, cbId);
    return;
  }
  if (!p) {
    await answerCallbackQuery(token, cbId, st(locale, "tgNoActiveEntry"));
    await editMessageText(token, chatId, messageId, st(locale, "tgEntryStale"));
    return;
  }

  if (data === "tgcat") {
    await editMessageText(token, chatId, messageId, confirmText(p, await categoryName(env, p.category_id), locale), await categoryKeyboard(env, locale));
    await answerCallbackQuery(token, cbId);
    return;
  }
  if (data.startsWith("tgsetcat:")) {
    const id = Number(data.slice("tgsetcat:".length)) || 0;
    p.category_id = id === 0 ? null : id;
    await setState(env.DB, pendingKey(chatId), JSON.stringify(p));
    await editMessageText(token, chatId, messageId, confirmText(p, await categoryName(env, p.category_id), locale), confirmKeyboard(locale));
    await answerCallbackQuery(token, cbId);
    return;
  }
  if (data === "tgsave") {
    await createCashTx(env.DB, {
      // The sign lives HERE and nowhere else: `p.amount` is positive by contract, so a handler
      // that forgets the direction produces an expense — the safe default, and the one the
      // confirmation the user just read was labelled with.
      amount: (p.kind === "income" ? 1 : -1) * Math.round(p.amount * 100),
      currency_code: p.currency_code,
      merchant: p.merchant,
      category_id: p.category_id,
      user_note: p.note,
      source: "cash",
    });
    await setState(env.DB, pendingKey(chatId), "");
    await editMessageText(token, chatId, messageId, st(locale, p.kind === "income" ? "tgSavedIncomeAs" : "tgSavedAs", { merchant: escapeHtml(p.merchant), amount: tgMoney(Math.round(p.amount * 100), p.currency_code, locale) }));
    await answerCallbackQuery(token, cbId, st(locale, "tgCbSaved"));
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
    /**
     * ⚠️ **A GROUP is never a personal notification channel.**
     *
     * Pressing the link in a group used to succeed: the row went into `tg_links`, and
     * `app_state.tg_chat_id` became the group — so every push from then on (a budget warning with
     * amounts, a «вагома операція» alert with the merchant and the sum, the weekly digest) landed
     * in a chat full of other people. Commands stayed silent, because the allowlist below happens
     * to require `fromId === chatId`, which is only true in a private chat — so the one visible
     * symptom was that the bot ignored you, while it quietly published your finances.
     *
     * That accidental gate is now the explicit rule, checked where the decision is actually made.
     * A deep link is a bearer token: forwarding one into a group must not be enough.
     */
    const chatType = update.message?.chat.type;
    if (chatType && chatType !== "private") {
      const { locale: refuseLocale } = await tgCtx(c.env);
      await sendMessage(c.env.TG_BOT_TOKEN, chatId, st(refuseLocale, "tgLinkPrivateOnly"));
      return c.text("ok", 200);
    }
    const { linkTgChat } = await import("../lib/messaging/tg-target.ts");
    // `USER_ID` is the header the Worker set when it routed this update here, so it is the id it
    // just verified from the signed token — the same proof, carried one hop. Passing it is what
    // writes the INBOUND index (directory 0008): without it the chat could receive pushes and
    // still have its commands go nowhere.
    await linkTgChat(c.env, chatId, c.env.USER_ID);
    const { locale: linkLocale } = await tgCtx(c.env);
    // The strip rides the very first message the chat receives: this is the one moment every
    // user passes through, since linking is the only way in.
    await sendMessage(c.env.TG_BOT_TOKEN, chatId, st(linkLocale, "tgChatLinked"), undefined, replyKeyboard(linkLocale));
    await markKeyboardShown(c.env, chatId);
    await ensureBotSurface(c.env, chatId, linkLocale);
    return c.text("ok", 200);
  }

  // Allowlist: лише ВЛАСНИЙ привʼязаний чат цього обʼєкта. Будь-хто інший — тихо ігноруємо
  // ⚠️ `fromId === chatId` is TRUE only in a private chat (Telegram uses the user id as the chat
  // id for a DM), so this doubles as "commands never answer in a group". That was incidental
  // until 2026-08-21; linking now refuses a group outright, and this stays as the second lock.
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
      } else if (update.message?.document) {
        // §TG-CSV — a bank statement, dropped into the chat.
        const { handleDocument } = await import("../lib/messaging/tg-import.ts");
        await handleDocument(c.env, chatId, update.message.document, new URL(c.req.url).origin);
      } else if (update.message?.text) {
        // The app origin IS this request's origin: the bot and the app are one Worker, so a
        // link built from it can never point at a different deployment than the reader's own.
        await handleText(c.env, chatId, update.message.text, new URL(c.req.url).origin);
      }
      // Attach whatever this chat has not seen yet — see `tg-surface.ts` for why it is lazy.
      await ensureBotSurface(c.env, chatId, (await tgCtx(c.env)).locale);
    } catch (e) {
      try {
        const { locale: errLocale } = await tgCtx(c.env);
        await sendMessage(c.env.TG_BOT_TOKEN, chatId, st(errLocale, "tgGenericError"));
      } catch { /* ignore */ }
      console.log(`[tg] error: ${String(e)}`);
    }
  })());

  return c.text("ok", 200);
});
