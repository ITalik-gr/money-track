/**
 * How a Telegram message is FORMATTED — escaping, money, bars, length.
 *
 * Created 2026-08-21 alongside the bot's statistics commands, and the first thing it does is
 * collapse four copies of `escapeHtml` (`routes/telegram.ts`, `tg-commands.ts`, `alert.ts`,
 * `proactive.ts`). They were byte-identical, which is not reassurance: the same file spent the
 * evening yielding three private currency-sign tables and a third copy of the budget canon, all
 * of which were byte-identical right up until one of them was not.
 *
 * `telegram.ts` next door stays the API CLIENT — what a request to Telegram looks like. This is
 * what the text inside it looks like.
 */
import { currencySign } from "../../../shared/currency.ts";
import { num, type ServerLocale } from "../platform/i18n.ts";

/** Telegram parses `parse_mode: HTML`, so anything user-supplied has to stop being markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A money figure for a chat: grouped in the reader's locale, signed in the given currency.
 *
 * ⚠️ `currency` is a PARAMETER and not a default of the display base, because the bot legitimately
 * prints both — a roll-up wears the reader's base, a single charge wears the currency it was
 * actually made in. Making one of them implicit is how the other one starts being wrong.
 */
export function tgMoney(minorUnits: number, currency: number, locale: ServerLocale): string {
  return `${num(locale, Math.round(minorUnits / 100))} ${currencySign(currency)}`;
}

/**
 * A proportion, drawn in characters.
 *
 * There are no charts in this bot and there will not be: a Worker has no canvas, and turning SVG
 * into PNG would mean an external service in the path of a push. A ten-cell bar is honest about
 * being a rough shape, which a blurry rendered chart would not be.
 *
 * ⚠️ Overflow gets its own marker rather than a longer bar — the same decision the envelope rows
 * make on the web (`.bh-bar > b`): a bar that can exceed its own track stops reading as a
 * proportion, and a proportion is the only thing it is for.
 */
export function bar(ratio: number, cells = 10): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "░".repeat(cells);
  const filled = Math.min(cells, Math.round(ratio * cells));
  return "█".repeat(filled) + "░".repeat(cells - filled) + (ratio > 1 ? "▓" : "");
}

/**
 * Telegram refuses a message over 4096 characters — with an error, not a truncation.
 *
 * So a long reply does not arrive short, it does not arrive at all, and the bot looks broken
 * rather than verbose. Every generated list here is cut to fit and says that it was.
 */
export const TG_MAX = 4096;

export function capMessage(text: string, moreLabel: string): string {
  if (text.length <= TG_MAX) return text;
  const suffix = `\n…\n${moreLabel}`;
  return text.slice(0, TG_MAX - suffix.length).replace(/\n[^\n]*$/, "") + suffix;
}
