/**
 * What the bot looks like in Telegram's OWN chrome: the ⌘ command menu and the persistent button
 * strip under the input field.
 *
 * Both were built on 2026-08-21 and neither appeared in production, for the same reason: each was
 * attached at exactly one moment nobody passes through twice. The menu was registered only inside
 * `POST /setup/register-telegram` — reachable by pressing a Settings button whose label says
 * «перереєструвати вебхук» and says nothing about a menu. The strip was attached only to the reply
 * to `/start` and `/help`, and Telegram keeps a reply keyboard until a message replaces it, so
 * somebody who linked the bot before the feature shipped would never see it: they have no reason
 * to type `/start` a second time.
 *
 * So both are attached LAZILY here instead, from any incoming update, guarded by a version. That
 * is the difference between a check and an instruction (`CLAUDE.md`, «Перевірка > інструкція»):
 * the version is derived from the labels themselves, so renaming a button re-attaches the strip
 * for everyone without anybody remembering to bump anything.
 */
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { setMyCommands, sendMessage } from "./telegram.ts";
import { botCommands, replyKeyboard } from "./tg-format.ts";
import { st, type ServerLocale } from "../platform/i18n.ts";

/** djb2 over the rendered surface — short enough to store, sensitive to any label change. */
function version(): string {
  const shape = JSON.stringify([
    botCommands("uk"), botCommands("en"), replyKeyboard("uk"), replyKeyboard("en"),
  ]);
  let h = 5381;
  for (let i = 0; i < shape.length; i++) h = ((h * 33) ^ shape.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const KB_KEY = (chatId: number | string) => `tg_kb_${chatId}`;
const CMD_KEY = "tg_commands_v";

/**
 * Register the ⌘ menu — OWNER only, because the command list is one resource shared by every chat
 * of the bot, and `CLAUDE.md §Безпека` gives that shape one answer: a resource that looks global is
 * the owner's. The content here is derived from code and identical for everyone, so letting any
 * object write it would leak nothing — but «harmless this time» is how the two cross-tenant holes
 * of 2026-07-26 were argued for, and the owner uses the bot, so the cheap gate costs nothing.
 */
async function ensureCommandMenu(env: Env, want: string): Promise<void> {
  if (!env.IS_OWNER || !env.TG_BOT_TOKEN) return;
  if (await getState(env.DB, CMD_KEY) === want) return;
  // English is the fallback list (no `language_code`); Ukrainian clients get theirs by interface
  // language — Telegram picks, not us.
  await setMyCommands(env.TG_BOT_TOKEN, botCommands("en"));
  await setMyCommands(env.TG_BOT_TOKEN, botCommands("uk"), "uk");
  await setState(env.DB, CMD_KEY, want);
}

/** The strip is attached to a reply the caller is already sending — record that it happened. */
export async function markKeyboardShown(env: Env, chatId: number | string): Promise<void> {
  await setState(env.DB, KB_KEY(chatId), version());
}

/**
 * Called after every handled update. Attaches whatever this chat has not seen yet.
 *
 * ⚠️ The strip rides its OWN short message rather than being threaded through the dozen handlers
 * that reply: a parameter every handler must remember to pass is the parameter the next handler
 * forgets, and this one is invisible when forgotten. One extra message per chat per version is the
 * price, and it says what just appeared instead of leaving new buttons unexplained.
 * ⚠️ Best-effort in full: failing to decorate the bot must never eat the answer the person asked
 * for, and Telegram rejecting `setMyCommands` (rate limit, revoked token) is not their problem.
 */
export async function ensureBotSurface(env: Env, chatId: number, locale: ServerLocale): Promise<void> {
  const want = version();
  try { await ensureCommandMenu(env, want); } catch { /* the menu can wait for the next update */ }
  try {
    if (await getState(env.DB, KB_KEY(chatId)) === want) return;
    await sendMessage(env.TG_BOT_TOKEN, chatId, st(locale, "tgButtonsHint"), undefined, replyKeyboard(locale));
    await markKeyboardShown(env, chatId);
  } catch { /* same */ }
}
