// Operation citations (`[tx:ID]`, `[tx:ID|caption]`) outside a surface that can render them.
/**
 * AI text with its operation citations turned back into plain prose — for surfaces that cannot
 * render a citation chip: a feed card's preview, a Telegram message.
 *
 * `[tx:ID|caption]` keeps its caption; a bare `[tx:ID]` goes (the name it follows is already in
 * the sentence). The weekly report's preview shipped «оплата квартири 12 500 ₴ [tx:Wd2iiFXN98cFeo-UIQ]»
 * — the client strips tokens where it renders a report, but the feed renders the text as given.
 *
 * Applied in the render TEMPLATE (`notif-i18n.ts`), not where the card is drafted: the stored body,
 * Telegram and the client all go through the template, and cards ALREADY stored with a raw token
 * read clean on the next render. That is also why a token cut in half by the drafter's length
 * limit has to be handled here.
 */
export function plainCitations(text: string): string {
  return text
    .replace(/\[tx:[^|\]]+\|([^\]]+)\]/g, "$1")
    .replace(/\s*\[tx:[^\]]*(?:\]|$)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
