/**
 * Quick expense entry from a chat — the draft, its confirmation and its keyboards.
 *
 * The last coherent unit to leave `routes/telegram.ts` (2026-08-21, C3 ceiling). What stays there
 * is the webhook, the routing and the dispatch; this is the small state machine behind «напиши
 * витрату текстом»: parse → show a draft → let the person change the category → save or cancel.
 *
 * ⚠️ The draft lives in `app_state`, keyed by CHAT, not by user. One person can hold one draft at
 * a time, which is what makes «press ✏️ Категорія, then pick» work across two messages without a
 * session of any kind.
 */
import type { Env } from "../../env.ts";
import * as catRepo from "../../repo/categories.ts";
import type { InlineKeyboard } from "./telegram.ts";
import { escapeHtml } from "./tg-format.ts";
import { tgMoney } from "./tg-format.ts";
import { st, type ServerLocale } from "../platform/i18n.ts";

export interface Pending {
  merchant: string;
  amount: number;       // major units, positive — the SIGN comes from `kind`, on save
  /** Which way the money went. Absent on a record stored before 2026-08-21 → expense, as it was. */
  kind?: "expense" | "income";
  currency_code: number;
  category_id: number | null;
  note: string | null;
  message_id: number;
}

export const pendingKey = (chatId: number) => `tg_pending_${chatId}`;
export const currencyCode = (c: string): number => (c === "USD" ? 840 : c === "EUR" ? 978 : 980);


export function confirmText(p: Pending, categoryName: string | null, locale: ServerLocale): string {
  return (
    st(locale, p.kind === "income" ? "tgParsedIncome" : "tgParsed") + "\n\n" +
    `<b>${escapeHtml(p.merchant || "—")}</b>\n` +
    // The amount stays in the currency the user TYPED (`p.currency_code`), not the display base:
    // this line is a confirmation of what will be stored, and converting it would ask them to
    // approve a different number than the one they are about to save.
    st(locale, "tgSumLine", { amount: tgMoney(Math.round(p.amount * 100), p.currency_code, locale) }) + "\n" +
    st(locale, "tgCategoryLine", {
      name: categoryName ? escapeHtml(categoryName) : st(locale, "tgUncategorized"),
    }) +
    (p.note ? "\n" + st(locale, "tgNoteLine", { note: escapeHtml(p.note) }) : "")
  );
}

export const confirmKeyboard = (locale: ServerLocale): InlineKeyboard => [
  [{ text: st(locale, "tgBtnSave"), callback_data: "tgsave" },
   { text: st(locale, "tgBtnCancel"), callback_data: "tgcancel" }],
  [{ text: st(locale, "tgBtnCategory"), callback_data: "tgcat" }],
];


export async function categoryName(env: Env, id: number | null): Promise<string | null> {
  if (id == null) return null;
  return catRepo.nameById(env.DB, id);
}

// Клавіатура вибору категорії: верхньорівневі витратні, по 2 в ряд + «без категорії».
export async function categoryKeyboard(env: Env, locale: ServerLocale): Promise<InlineKeyboard> {
  const kb: InlineKeyboard = [];
  const cats = await catRepo.topLevelExpense(env.DB);
  for (let i = 0; i < cats.length; i += 2) {
    kb.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `tgsetcat:${c.id}` })));
  }
  kb.push([{ text: st(locale, "tgUncategorized"), callback_data: "tgsetcat:0" }]);
  return kb;
}

