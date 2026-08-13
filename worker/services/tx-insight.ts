// Two questions the operation page asks ABOUT an operation rather than about the table: "why is it
// filed here?" and "what else looks like this?" (2026-08-13/14).
//
// They live in a service because each is a sequence — read the row, recover the raw bank text,
// re-run a decision, look up a name — and because the route file that owned them hit its 400-line
// ceiling (C3). That ceiling is doing its job here: the handlers had grown bodies, and a body in a
// route is a body nothing else can reuse or test in isolation.
import type { Env } from "../env.ts";
import type { NotifLocale } from "../../shared/notif-i18n.ts";
import type { CategoryWhy, SimilarTxList } from "../../shared/api/transactions.ts";
import * as txRepo from "../repo/transactions.ts";
import * as categoriesRepo from "../repo/categories.ts";
import { categorize } from "../lib/finance/categorize.ts";
import { coreToken } from "../lib/finance/merchants.ts";

/**
 * The bank's OWN text for a row.
 *
 * Both answers depend on it: `merchant` may have been rewritten to a clean name by enrichment
 * ("Silpo"), while the engine matched on the raw line ("SILPO 4506 KYIV"). Explaining or grouping
 * by the cleaned name produces a confident wrong answer — the §RULES-UI bug, one screen over.
 */
function rawDescription(rawJson: string | null): string | null {
  if (!rawJson) return null;
  try {
    return (JSON.parse(rawJson) as { description?: string }).description ?? null;
  } catch {
    return null; // a payload we cannot parse is not a reason to fail the page
  }
}

/**
 * What the deterministic chain says about this operation TODAY.
 *
 * Runs `categorize()` rather than reconstructing what it would have said: one implementation
 * decides and the same one explains, so an explanation cannot drift away from the behaviour.
 * ⚠️ It is NOT a record of what happened when the row arrived — nothing stores that. The UI says
 * so, because an explanation that quietly claims to be history would be believed.
 */
export async function explainCategory(
  env: Env,
  locale: NotifLocale,
  id: string,
): Promise<CategoryWhy | null> {
  const row = await txRepo.byId(env.DB, locale, id);
  if (!row) return null;

  const verdict = await categorize(env.DB, {
    mcc: row.mcc ?? null,
    description: rawDescription(row.raw_json) ?? row.merchant ?? null,
    comment: row.comment ?? null,
    amount: row.amount,
    currency_code: row.currency_code,
  });

  return {
    source: verdict.source ?? null,
    detail: verdict.detail ?? null,
    category_id: verdict.category_id,
    category_name: verdict.category_id != null
      ? await categoriesRepo.nameOf(env.DB, locale, verdict.category_id)
      : null,
    agrees: (verdict.category_id ?? null) === (row.category_id ?? null),
    ai_enriched: !!row.ai_enriched,
    ai_note: row.ai_note ?? null,
  };
}

/** Operations of the same kind that WOULD change if this one's filing were applied to them. */
export async function similarTo(
  env: Env,
  locale: NotifLocale,
  id: string,
): Promise<SimilarTxList | null> {
  const row = await txRepo.byId(env.DB, locale, id);
  if (!row) return null;

  const token = coreToken(rawDescription(row.raw_json) ?? row.merchant);
  if (!token) return { token: null, items: [] };

  return {
    token,
    items: await txRepo.findSimilar(
      env.DB, row.id, token,
      { category_id: row.category_id ?? null, is_transfer: row.is_transfer ?? 0 },
      locale,
    ),
  };
}
