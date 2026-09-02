// Мінімальний fetch-клієнт Telegram Bot API (як lib/mono.ts). Лише те, що треба боту:
// sendMessage, editMessageText, answerCallbackQuery, sendChatAction, setWebhook, getFile.
const API = "https://api.telegram.org";

export interface InlineButton { text: string; callback_data: string }
export type InlineKeyboard = InlineButton[][];

async function call<T = unknown>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
  return data.result as T;
}

/** §D1 — bot username, needed to build the `t.me/<bot>?start=…` deep link. */
export async function getBotUsername(token: string): Promise<string> {
  const me = await call<{ username: string }>(token, "getMe", {});
  return me.username;
}

/**
 * The persistent button strip under the input field.
 *
 * A different thing from `InlineKeyboard`, and the difference decides where each belongs: an
 * inline keyboard hangs under ONE message and answers with `callback_data`, while this one
 * replaces the user's keyboard and answers by sending its own label as plain TEXT. So every label
 * here has to be something the text dispatcher already understands — see `REPLY_KEYBOARD`.
 */
export type ReplyKeyboard = { text: string }[][];

export async function sendMessage(
  token: string, chatId: number | string, text: string,
  keyboard?: InlineKeyboard, replyKeyboard?: ReplyKeyboard,
): Promise<{ message_id: number }> {
  const markup = keyboard
    ? { reply_markup: { inline_keyboard: keyboard } }
    : replyKeyboard
      // `is_persistent` keeps the strip open instead of collapsing into the ⌨️ icon after one
      // use; `resize_keyboard` stops six buttons taking half the screen on a phone.
      ? { reply_markup: { keyboard: replyKeyboard, resize_keyboard: true, is_persistent: true } }
      : {};
  const base = { chat_id: chatId, text, disable_web_page_preview: true, ...markup };
  try {
    return await call(token, "sendMessage", { ...base, parse_mode: "HTML" });
  } catch {
    // Стійкість: якщо Telegram не розпарсив HTML-розмітку — шлемо як звичайний текст.
    return call(token, "sendMessage", base);
  }
}

export async function editMessageText(
  token: string, chatId: number | string, messageId: number, text: string, keyboard?: InlineKeyboard,
): Promise<unknown> {
  const base = {
    chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : { inline_keyboard: [] },
  };
  try {
    return await call(token, "editMessageText", { ...base, parse_mode: "HTML" });
  } catch {
    return call(token, "editMessageText", base);
  }
}

export function answerCallbackQuery(token: string, id: string, text?: string): Promise<unknown> {
  return call(token, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

export function sendChatAction(token: string, chatId: number | string, action = "typing"): Promise<unknown> {
  return call(token, "sendChatAction", { chat_id: chatId, action });
}

// Реєстрація вебхука з secret_token — Telegram шле його в X-Telegram-Bot-Api-Secret-Token.
export function setWebhook(token: string, url: string, secretToken: string): Promise<unknown> {
  return call(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
  });
}

// Отримати file_path за file_id (для фото чека), далі качаємо з /file/bot<token>/<path>.
export async function getFileBytes(token: string, fileId: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const file = await call<{ file_path: string }>(token, "getFile", { file_id: fileId });
  const res = await fetch(`${API}/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram download: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mediaType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
  return { bytes, mediaType };
}

// ---- Telegram update shapes (лише поля, що використовуємо) -------------------

/**
 * Register the command list — what the ⌘ Menu button next to the input field shows.
 *
 * Done from the app rather than by hand in BotFather so the list ships with the code that
 * implements it: a command added here and forgotten there is a menu entry that answers nothing,
 * and a command removed from the code but left in the menu is worse.
 *
 * ⚠️ Per LANGUAGE. Telegram picks by the client's interface language, and a list registered
 * without `language_code` is the fallback for everyone else — so the Ukrainian list goes in under
 * `uk` and the English one as the default, not the other way round.
 */
export async function setMyCommands(
  token: string, commands: { command: string; description: string }[], languageCode?: string,
): Promise<void> {
  await call(token, "setMyCommands", {
    commands,
    ...(languageCode ? { scope: { type: "default" }, language_code: languageCode } : {}),
  });
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface TgMessage {
  message_id: number;
  from?: { id: number };
  /**
   * `type` is "private" | "group" | "supergroup" | "channel".
   *
   * Read since 2026-08-21 because linking is only ever legitimate in a PRIVATE chat — see the
   * refusal in `routes/telegram.ts`. It was absent from this shape, which is why the question
   * could not be asked.
   */
  chat: { id: number; type?: string };
  text?: string;
  photo?: { file_id: string; file_size?: number }[];
  /** §TG-CSV — a file attachment. A statement arrives here, not in `photo`. */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
export interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}
