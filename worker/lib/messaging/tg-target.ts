/**
 * §D1 — КОМУ шле цей Durable Object. ЄДИНЕ джерело адресата для всіх push-точок.
 *
 * Історія, через яку цей файл існує (аудит 2026-07-26, друга діра): `TG_CHAT_ID` — це ОДИН
 * глобальний чат, чат власника, а гілка крону виконується в обʼєкті КОЖНОГО юзера. Тобто
 * сповіщення запрошеного друга («ти витратив 3 400 ₴ на Продукти») прилітали в Telegram
 * ВЛАСНИКА: його телефон, чужі дані. Тоді це закрили найтупішим надійним способом — гейтом
 * `env.IS_OWNER` у всіх чотирьох точках відправки, тобто вимкнули фічу для решти.
 *
 * Тепер адресат — власний: кожен привʼязує СВІЙ чат (`app_state.tg_chat_id`), бот лишається
 * один. Правило, що замінює старий гейт:
 *
 *   **фолбек на deployment-секрет `TG_CHAT_ID` — ЛИШЕ для власника.**
 *
 * Це той самий інваріант, що й для `MONO_TOKEN`/`ANTHROPIC_API_KEY` (§Безпека): ресурс, який
 * ВИГЛЯДАЄ глобальним, насправді власників. Юзер без привʼязки просто не отримує пушів —
 * чесний стан, а не чужа адреса.
 */
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";

export const TG_CHAT_KEY = "tg_chat_id";

/** Куди слати з ЦЬОГО обʼєкта, або null — якщо нема куди (тоді пуш просто не відбувається). */
export async function tgTarget(env: Env): Promise<{ token: string; chatId: string } | null> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return null;
  const own = await getState(env.DB, TG_CHAT_KEY);
  // ⚠️ Порядок саме такий: власна привʼязка ЗАВЖДИ важливіша за глобальний секрет. Інакше
  // власник, який привʼязав окремий чат, і далі отримував би все у старий.
  if (own) return { token, chatId: own };
  /**
   * ⚠️ **An EMPTY row is «I unlinked this», and it outranks the deployment fallback** (2026-08-21,
   * reported by the owner: «коли відключаю тг бота в веб апці, то тг ботом все ще можу
   * користуватись і брати інфу»).
   *
   * `unlinkTgChat` writes `""` rather than deleting, and both readers treated that as «never
   * linked» — so for the ONE account that has a deployment chat, unlinking restored the very
   * thing it had just switched off: pushes resumed, and since this function is also the INBOUND
   * allowlist, the bot went on answering `/balance` from the same chat. The only person with a
   * switch could not use it.
   *
   * `null` (no row at all) still falls through, so an owner who never linked keeps the historical
   * behaviour — the fallback exists for exactly that case and for no other.
   */
  if (own === "") return null;
  if (env.IS_OWNER && env.TG_CHAT_ID) return { token, chatId: String(env.TG_CHAT_ID) };
  return null;
}

/**
 * Привʼязати чат — ЄДИНИЙ писар ОБОХ сховищ.
 *
 * Їх справді два, і це не дублювання: `app_state.tg_chat_id` каже, куди пушить ЦЕЙ обʼєкт
 * (вихідний бік, §D1), а `tg_links` у спільній directory каже, ЧИЙ це чат — відповідь, потрібна
 * воркеру ДО того, як він зможе звернутись до будь-якого обʼєкта. Обʼєкт не вміє знайти себе за
 * імʼям (`idFromName` односторонній), тож із однієї таблиці другу не вивести.
 *
 * Раз їх два — писар мусить бути один, інакше це рівно та вада, яку цей проєкт ловив увесь
 * 2026-08-21: два записи одного факту, що розходяться там, куди ніхто не дивиться.
 *
 * ⚠️ Запис у directory — best-effort: не змогти проіндексувати чат гірше, ніж не привʼязати
 * його, але ще гірше — впасти в мідлварі вебхука й лишити людину без відповіді. Розбіжність
 * самолікується наступним `/start`.
 */
export async function linkTgChat(env: Env, chatId: string | number, userId?: string): Promise<void> {
  const previous = await getState(env.DB, TG_CHAT_KEY);
  await setState(env.DB, TG_CHAT_KEY, String(chatId));

  /**
   * A rebind is ANNOUNCED to the chat that just lost the account.
   *
   * The link token is a bearer token with a 15-minute life; a URL that leaks (a screenshot, a
   * forwarded message) lets whoever presses it take over the channel — and since 2026-08-21 that
   * channel can read balances and transactions, not just receive notifications. Forgery cannot be
   * prevented by the token alone. What CAN be prevented is the takeover being silent, which is the
   * same reasoning §REVOKE applies to sessions: you cannot stop a stolen key from working once,
   * you can make sure the owner finds out.
   *
   * Best-effort: failing to warn must not fail the link the person is actually performing.
   */
  if (previous && previous !== String(chatId) && env.TG_BOT_TOKEN) {
    try {
      const { sendMessage } = await import("./telegram.ts");
      const { st, resolveLocale } = await import("../platform/i18n.ts");
      await sendMessage(env.TG_BOT_TOKEN, previous, st(await resolveLocale(env), "tgRelinked"));
    } catch { /* the old chat may be gone, blocked, or unreachable */ }
  }

  if (userId && env.DIRECTORY) {
    try {
      const { linkTgChatToUser } = await import("../platform/directory.ts");
      await linkTgChatToUser(env.DIRECTORY, String(chatId), userId);
    } catch { /* directory may predate migration 0008 */ }
  }
}

export async function unlinkTgChat(env: Env): Promise<void> {
  /**
   * Who is ABOUT to lose the bot — asked from the ONE resolver rather than read from the row.
   *
   * That difference is the whole fix: an owner running on the deployment fallback has no row of
   * their own, so a version that read `app_state` found nothing to detach and did nothing
   * visible — while the fallback kept the channel alive. `tgTarget` answers for both shapes,
   * which is what it is for.
   */
  const losing = await tgTarget(env);

  // Порожній рядок, а не DELETE: `setState` — це upsert, тож окремий шлях видалення нічого не
  // додав би. ⚠️ І, як виявилось 2026-08-21, рядок значить БІЛЬШЕ за його відсутність: порожній
  // — це «я відвʼязав», і саме на цьому тримається відмова від deployment-фолбека в `tgTarget`.
  await setState(env.DB, TG_CHAT_KEY, "");
  if (!losing) return;

  // Знімаємо і маршрут: інакше «відвʼязав» означало б «більше не отримую пушів, але бот усе ще
  // виконує мої команди з того чату» — половина відвʼязки, і саме та половина, що про доступ.
  if (env.DIRECTORY) {
    try {
      const { unlinkTgChatRow } = await import("../platform/directory.ts");
      await unlinkTgChatRow(env.DIRECTORY, losing.chatId);
    } catch { /* directory may predate migration 0008 */ }
  }

  /**
   * The chat is TOLD, whichever side pressed the button.
   *
   * Symmetric with the rebind warning above and for the same reason: from inside Telegram the
   * difference between «detached» and «broken» is invisible, and after this the bot answers
   * nothing at all. `/unlink` used to say this itself; saying it here instead means the button in
   * Settings says it too, from the one writer that knows the unlink actually happened.
   */
  try {
    const { sendMessage } = await import("./telegram.ts");
    const { st, resolveLocale } = await import("../platform/i18n.ts");
    await sendMessage(losing.token, losing.chatId, st(await resolveLocale(env), "tgUnlinkDone"));
  } catch { /* the chat may be gone or the bot blocked — the unlink still stands */ }
}

/** Чи привʼязаний власний чат (для UI Налаштувань). */
export async function tgLinkedChat(env: Env): Promise<string | null> {
  return (await getState(env.DB, TG_CHAT_KEY)) || null;
}
