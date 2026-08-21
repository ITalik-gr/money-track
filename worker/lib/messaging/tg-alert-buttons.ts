/**
 * The buttons under a per-transaction alert, and what they do.
 *
 * Moved out of `routes/telegram.ts` on 2026-08-21 under the C3 ceiling, and it belongs here: the
 * message these buttons hang under is built by `alert.ts` next door, and until now the two halves
 * of one interaction sat in different layers. The route keeps the webhook, the routing and the
 * dispatch; what an alert OFFERS and what pressing it does is the messaging layer's business.
 */
import type { Env } from "../../env.ts";
import * as catRepo from "../../repo/categories.ts";
import { answerCallbackQuery, editMessageText, type InlineKeyboard } from "./telegram.ts";
import { applyAlertRealCategory, applyAlertCategory, applyAlertTransfer } from "./alert.ts";
import { escapeHtml } from "./tg-format.ts";
import { st, resolveLocale, type ServerLocale } from "../platform/i18n.ts";

async function categoryName(env: Env, id: number | null): Promise<string | null> {
  if (id == null) return null;
  return catRepo.nameById(env.DB, id);
}

async function alertCategoryKeyboard(env: Env, txId: string, mode: "real" | "cat", locale: ServerLocale): Promise<InlineKeyboard> {
  // 13 = «Перекази і зняття»: the question this keyboard asks is what the transfer really WAS,
  // and «a transfer» is the one answer that carries no information.
  const cats = await catRepo.topLevelExpense(env.DB, 13);
  const set = mode === "real" ? "al_setreal" : "al_setcat";
  const kb: InlineKeyboard = [];
  for (let i = 0; i < cats.length; i += 2) {
    kb.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `${set}:${txId}:${c.id}` })));
  }
  kb.push([{ text: st(locale, mode === "real" ? "tgUndetermined" : "tgUncategorized"), callback_data: `${set}:${txId}:0` }]);
  return kb;
}

// Дії з кнопок пер-транзакційного алерту (§F2 крок 2). Немає pending-запису — свій потік.
export async function handleAlertCallback(env: Env, chatId: number, messageId: number, cbId: string, data: string): Promise<boolean> {
  const token = env.TG_BOT_TOKEN;
  const locale = await resolveLocale(env);
  const parts = data.split(":");
  const prefix = parts[0];
  const txId = parts[1];
  if (!prefix.startsWith("al_") || !txId) return false;

  if (prefix === "al_ok") {
    await editMessageText(token, chatId, messageId, st(locale, "tgLeftAsIs"));
    await answerCallbackQuery(token, cbId);
    return true;
  }
  if (prefix === "al_transfer") {
    await applyAlertTransfer(env, txId);
    await editMessageText(token, chatId, messageId, st(locale, "tgMarkedTransfer"));
    await answerCallbackQuery(token, cbId, st(locale, "tgCbDone"));
    return true;
  }
  if (prefix === "al_cat") {
    const mode = parts[2] === "cat" ? "cat" : "real";
    await editMessageText(token, chatId, messageId, st(locale, "tgChooseCategory"), await alertCategoryKeyboard(env, txId, mode, locale));
    await answerCallbackQuery(token, cbId);
    return true;
  }
  if (prefix === "al_setreal" || prefix === "al_setcat") {
    const catId = Number(parts[2]) || 0;
    const resolved = catId === 0 ? null : catId;
    if (prefix === "al_setreal") await applyAlertRealCategory(env, txId, resolved);
    else await applyAlertCategory(env, txId, resolved);
    const name = await categoryName(env, resolved);
    const label = st(locale, prefix === "al_setreal" ? "tgRealCategoryLabel" : "tgCategoryLabelShort");
    await editMessageText(token, chatId, messageId, `✅ ${label}: <b>${escapeHtml(name ?? st(locale, "tgSkipped"))}</b>`);
    await answerCallbackQuery(token, cbId, st(locale, "tgCbSaved"));
    return true;
  }
  return false;
}
