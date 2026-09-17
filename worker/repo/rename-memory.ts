// §RENAME-MEMORY — the name the user keeps typing over a bank's description is applied for them.
//
// THE ASK (owner, 2026-09-17): «a name is no good for me and I keep changing it to mine — the app
// should understand, and when it sees that name again with about the same amount, change it to
// mine; and if it did so itself, note it on the transaction so I know».
//
// The explicit path already existed — the «remember for similar» checkbox writes a manual
// `merchant_aliases` row keyed by the exact bank description. It needs the person to know about
// the checkbox, and it cannot tell «Переказ 12 500 → Оренда» from «Переказ 300 → Кава» under the
// same description. This is the implicit path, and it is DERIVED FROM HISTORY rather than stored:
// what the user renamed, and to what, is already in `transactions`. A second table would be a
// second copy of those decisions, and it would keep a rule alive after the user changed their mind.
//
// The bank's text is `raw_json.description` — the ingest keeps it verbatim, and it is the only
// thing that stays the same between two arrivals of "the same" operation (the merchant column is
// what gets renamed).
//
// ⚠️ `name_locked` has THREE states: 0 free, 1 typed by the person, 2 applied by this memory.
// Learning reads only 1. Otherwise one confirmed rule would reinforce itself from its own output
// forever, and a name the person never typed a second time could never fade.
import type { AppDb } from "../lib/platform/db-shim.ts";

/** Manual renames that must agree before the app repeats one on its own. One could be a one-off. */
export const RENAME_QUORUM = 2;
/** «About the same amount»: within 15% — a price that drifts, not a different kind of payment. */
export const RENAME_AMOUNT_TOLERANCE = 0.15;

export interface RenameSample { merchant: string; amount: number }

/**
 * Pure half: given the person's past renames of one bank description (newest first), the name to
 * apply to a new operation of `amount`, or null. The newest `RENAME_QUORUM` samples within the
 * amount band must all carry the same name — a person who renamed it differently last time has
 * not settled on anything yet.
 */
export function pickRememberedName(samples: RenameSample[], amount: number): string | null {
  const near = samples.filter((s) =>
    Math.sign(s.amount) === Math.sign(amount)
    && Math.abs(s.amount - amount) <= Math.abs(amount) * RENAME_AMOUNT_TOLERANCE);
  if (near.length < RENAME_QUORUM) return null;
  const names = new Set(near.slice(0, RENAME_QUORUM).map((s) => s.merchant.trim()));
  return names.size === 1 ? [...names][0]! : null;
}

export async function rememberedName(db: AppDb, bankDescription: string, amount: number): Promise<string | null> {
  const desc = bankDescription.trim();
  if (!desc) return null;
  const r = await db.prepare(
    `SELECT merchant, amount FROM transactions
     WHERE name_locked = 1 AND merchant IS NOT NULL AND TRIM(merchant) <> ''
       AND json_extract(raw_json, '$.description') = ? AND merchant <> ?
     ORDER BY time DESC LIMIT 20`,
  ).bind(desc, desc).all<RenameSample>();
  return pickRememberedName(r.results ?? [], amount);
}
