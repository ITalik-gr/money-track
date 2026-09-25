/**
 * §QUERY-PARSE — the search text turned into feed filters, for the feed AND for the assistants'
 * `find_transactions` (chat and MCP): one reading of a sentence, wherever it is typed. The parser
 * itself is pure (`query-parse.ts`); this feeds it the reader's category names and maps its answer
 * onto `FeedFilter`. In `lib/` rather than `services/` so `lib/ai/chat-tools.ts` can use it
 * without reaching UP a layer.
 */
import type { AppDb } from "../platform/db-shim.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";
import type { ParsedQuery } from "../../../shared/api/transactions.ts";
import type { FeedFilter } from "../../repo/transactions.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import { localizeCatName } from "./categories-i18n.ts";
import { parseQuery } from "./query-parse.ts";

export async function parseForReader(db: AppDb, locale: NotifLocale, q: string, now: number): Promise<ParsedQuery> {
  // BOTH spellings of a seeded category are offered — the reader's and the stored one — so «продукти»
  // works on an English screen and «groceries» on a Ukrainian one; a user's own name passes as typed.
  const cats = (await categoriesRepo.listAll(db)).flatMap((c) => {
    const shown = localizeCatName(locale, c.name);
    const rows = [{ id: c.id, name: shown, parent_id: c.parent_id ?? null }];
    if (shown !== c.name) rows.push({ id: c.id, name: c.name, parent_id: c.parent_id ?? null });
    return rows;
  });
  return parseQuery(q, cats, now);
}

/**
 * The parsed query as feed filters. An explicit filter the caller ALSO sent wins over the parsed one
 * — the panel is the more deliberate of the two inputs.
 */
export function mergeParsed(f: FeedFilter, p: ParsedQuery): FeedFilter {
  const words = p.text ? p.text.split(/\s+/).filter((w) => w.length >= 2) : [];
  return {
    ...f,
    q: undefined,
    qWords: words.length ? words : undefined,
    qNot: p.exclude.length ? p.exclude : undefined,
    category: f.category ?? p.category,
    catparent: f.catparent ?? p.catparent,
    type: f.type ?? p.type,
    from: f.from ?? p.from,
    to: f.to ?? p.to,
    aminMinor: f.aminMinor ?? (p.amin !== undefined ? Math.round(p.amin * 100) : undefined),
    amaxMinor: f.amaxMinor ?? (p.amax !== undefined ? Math.round(p.amax * 100) : undefined),
  };
}
