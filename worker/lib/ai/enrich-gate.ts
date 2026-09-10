/**
 * §ENRICH-GATE — which incoming operation is worth a model call, and which one the app already knows.
 *
 * The owner's case: an Apple subscription charge of 44,35 ₴ arrived, an MCC rule filed it under
 * «Сервіси, SaaS продукти», and it sat there as an ordinary purchase. Only after he pressed
 * «Розпізнати» by hand did the app understand it was a SUBSCRIPTION and draw the icon. Nothing
 * was broken — the webhook's gate was `category_id IS NULL`, so an operation the rules HAD filed
 * never reached enrichment at all, and `ai_recurring` (the flag the icon and §SUB-DETECT read) is
 * only ever written by enrichment.
 *
 * That gate answers the wrong question. «Do we have a category» and «is there anything left to
 * learn» are different, and the second one is the one enrichment exists for: the rules can say
 * WHAT SHOP this is and cannot say whether it repeats, whether the name is a brand or bank noise,
 * or which of the user's declared plans it belongs to.
 *
 * ⚠️ **The answer is not «enrich everything».** The owner asked for exactly the right shape:
 * «щоб воно кожну транзакцію по дефолту розпізнавало… або скоріш не всі, а оце часті по типу
 * продуктів, між картками, округлення балансу не розпізнавало через аі, бо там і так все
 * зрозуміло». A grocery run at MCC 5411 has no brand to clean, no rhythm to find and no plan to
 * belong to; asking a model about it is money spent to be told what the MCC already said. So this
 * file is a filter with three answers, and only one of them costs anything:
 *
 *  • **skip** — a class where the deterministic answer is complete. Own-money movements and the
 *    everyday MCCs below.
 *  • **carry** — this merchant has been enriched before, so the verdict is COPIED. Free, and it
 *    is the common case for a subscription: the second Apple charge never needs asking.
 *  • **ask** — genuinely new, or a category the rules could not supply at all (the old gate).
 *
 * ⚠️ **Nothing here decides a CATEGORY.** A skip leaves `ai_recurring` untouched rather than
 * writing 0: the column deliberately distinguishes «asked, and no» from «never asked»
 * (migration 0046), and a gate that answers on the model's behalf would make the two identical —
 * after which nothing could ever come back and look again.
 */
import type { Env } from "../../env.ts";
import { descriptionIsTransfer } from "../finance/transfers.ts";
import { TRANSFER_CAT } from "./enrich.ts";

/**
 * MCCs where the rules are already the whole answer, so a model call buys nothing.
 *
 * The test each one passes: the category is unambiguous from the code alone, the merchant name
 * carries no brand worth cleaning, and **a subscription cannot be billed under it** — which is
 * what makes the skip safe, because the subscription flag is the one thing only enrichment can
 * find. Streaming, software, cloud, telecom, gyms, insurance and everything else that bills on a
 * schedule are deliberately absent from this list.
 *
 * ⚠️ Groceries (5411) are the reason the list exists: they are the single biggest slice of an
 * ordinary month's row count, and every one of them would otherwise be a paid question with a
 * foregone answer.
 */
const OBVIOUS_MCC = new Set([
  5411, 5412, 5422, 5441, 5451, 5462, 5499,  // groceries, bakery, butcher, market
  5812, 5813, 5814,                          // restaurants, bars, fast food
  5541, 5542,                                // fuel
  4111, 4121, 4131,                          // transit, taxi, coach
  5912,                                      // pharmacy
  6011, 6010,                                // ATM and over-the-counter cash
]);

export type EnrichVerdict =
  | { verdict: "ask" }
  | { verdict: "skip"; why: string }
  /** A merchant already enriched: `recurring` is that verdict, copied rather than re-bought. */
  | { verdict: "carry"; recurring: 0 | 1; merchant: string | null };

interface GateRow {
  id: string;
  merchant: string | null;
  mcc: number | null;
  amount: number;
  category_id: number | null;
  is_transfer: number;
  transfer_pair_id: string | null;
  ai_enriched: number;
  raw_json: string | null;
}

/** The row the gate needs. One read, and the caller does not have to know the column list. */
export async function gateRow(env: Env, id: string): Promise<GateRow | null> {
  return await env.DB.prepare(
    `SELECT id, merchant, mcc, amount, category_id, is_transfer, transfer_pair_id, ai_enriched, raw_json
     FROM transactions WHERE id = ?`,
  ).bind(id).first<GateRow>();
}

function rawDescription(raw: string | null): string | null {
  if (!raw) return null;
  try { return (JSON.parse(raw) as { description?: string }).description?.trim() || null; }
  catch { return null; }
}

/**
 * Has this merchant already been through enrichment, and what did it conclude?
 *
 * Matched on the EXACT merchant name and on the bank's exact raw description, either of which is
 * enough — deliberately narrower than `consensusCategory`'s fuzzy root token, because that one is
 * answering «what category do similar charges get» (where being roughly right is useful) and this
 * one is answering «is this a subscription» (where being roughly right about a different merchant
 * would plant a false icon nobody asked for and nobody would think to check).
 *
 * ⚠️ Only rows that were actually ASKED count: `ai_enriched = 1`. A charge the gate itself skipped
 * carries no verdict, and treating its untouched 0 as «no» would let one skip propagate forever.
 */
async function previousVerdict(
  env: Env, row: GateRow, desc: string | null,
): Promise<{ recurring: 0 | 1; merchant: string | null } | null> {
  if (!row.merchant && !desc) return null;
  const hit = await env.DB.prepare(
    `SELECT t.merchant, COALESCE(t.ai_recurring, 0) AS ai_recurring
     FROM transactions t
     WHERE t.id != ? AND t.ai_enriched = 1 AND t.ai_recurring IS NOT NULL
       AND (
         (? IS NOT NULL AND LOWER(t.merchant) = LOWER(?))
         OR (? IS NOT NULL AND LOWER(json_extract(t.raw_json, '$.description')) = LOWER(?))
       )
     ORDER BY t.time DESC LIMIT 1`,
  ).bind(row.id, row.merchant, row.merchant, desc, desc)
    .first<{ merchant: string | null; ai_recurring: number }>();
  return hit ? { recurring: hit.ai_recurring ? 1 : 0, merchant: hit.merchant } : null;
}

/**
 * What to do with one freshly ingested operation.
 *
 * Order matters and each step is a reason not to reach the next one: an own-money movement is
 * skipped before we look for history (a round-up has plenty of identical siblings), and history
 * is consulted before the MCC list (a known subscription billed at a listed MCC — a café that
 * sells a monthly pass, say — should still carry its own verdict rather than be waved through).
 */
export async function enrichVerdict(env: Env, row: GateRow): Promise<EnrichVerdict> {
  if (row.ai_enriched) return { verdict: "skip", why: "already enriched" };

  const desc = rawDescription(row.raw_json);

  // Own money moving between own places: card-to-card, a jar top-up, a balance round-up. There is
  // no merchant, no rhythm and no category to find — §F2 already owns this class, and the pair
  // detector has just run on this very event.
  if (row.is_transfer || row.transfer_pair_id || descriptionIsTransfer(desc)) {
    return { verdict: "skip", why: "own funds moving" };
  }
  const bucket = row.category_id != null
    ? await env.DB.prepare(
        "SELECT COALESCE(parent_id, id) AS root FROM categories WHERE id = ?",
      ).bind(row.category_id).first<{ root: number }>()
    : null;
  if (bucket?.root === TRANSFER_CAT) return { verdict: "skip", why: "transfers bucket" };

  // No category at all — the original gate, and still the strongest reason to ask.
  if (row.category_id == null) return { verdict: "ask" };

  // Income is out of scope: `ai_recurring` is about a charge that repeats, and the salary side is
  // §INCOME-PLAN's subject, with its own schedule and its own detector.
  if (row.amount >= 0) return { verdict: "skip", why: "income" };

  const seen = await previousVerdict(env, row, desc);
  if (seen) return { verdict: "carry", recurring: seen.recurring, merchant: seen.merchant };

  if (row.mcc != null && OBVIOUS_MCC.has(row.mcc)) {
    return { verdict: "skip", why: `mcc ${row.mcc} is already the whole answer` };
  }
  return { verdict: "ask" };
}

/**
 * Apply a `carry` verdict: the subscription flag from a charge that was already paid for.
 *
 * ⚠️ It writes `ai_recurring` and NOTHING else. The category is already set (that is why we are on
 * this branch at all), and the name is left alone: `merchant` may have been cleaned by hand
 * (§R7 `name_locked`), and a gate that rewrites names would be doing enrichment's job without
 * enrichment's checks. `ai_enriched` stays 0 on purpose — nobody asked a model about THIS row, and
 * setting the flag would hide it from the manual «Розпізнати» path and from `enrichPending`.
 */
export async function applyCarry(env: Env, id: string, recurring: 0 | 1): Promise<void> {
  await env.DB.prepare(
    "UPDATE transactions SET ai_recurring = ? WHERE id = ? AND ai_recurring IS NULL",
  ).bind(recurring, id).run();
}
