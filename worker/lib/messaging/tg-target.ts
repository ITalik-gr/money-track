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
  if (env.IS_OWNER && env.TG_CHAT_ID) return { token, chatId: String(env.TG_CHAT_ID) };
  return null;
}

export async function linkTgChat(env: Env, chatId: string | number): Promise<void> {
  await setState(env.DB, TG_CHAT_KEY, String(chatId));
}

export async function unlinkTgChat(env: Env): Promise<void> {
  // Порожній рядок, а не DELETE: `getState` віддає null для обох, а `setState` — це upsert,
  // тож окремий шлях видалення тут нічого не додав би.
  await setState(env.DB, TG_CHAT_KEY, "");
}

/** Чи привʼязаний власний чат (для UI Налаштувань). */
export async function tgLinkedChat(env: Env): Promise<string | null> {
  return (await getState(env.DB, TG_CHAT_KEY)) || null;
}
