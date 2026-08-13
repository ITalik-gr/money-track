// One-time maintenance: un-transliterate merchant names (ROADMAP L5).
//
// THE DAMAGE: before the enrich prompt forbade transliteration, the model rewrote `SILPO` as
// «Сільпо» and `Glovo` as «Глово». The merchant NAME is the key that `merchant_alias`, the
// consensus rule and the merchant page all join on, so one shop ended up as two histories —
// half the spending under each spelling, and neither number is the truth.
//
// WHY THIS IS DETERMINISTIC AND NOT A RE-ENRICH: the Latin original is already in the row, in
// `raw_json.description` (the bank's own text). Asking a model to re-derive a name we already
// have would cost money per transaction and could invent a third spelling. The one thing a model
// is needed for — turning `SILPO 4506 KYIV` into `Silpo` — has usually already been done for
// SOME transaction of the same merchant (the ones enriched after the prompt fix), so preferring
// an existing Latin name of the same merchant reuses that work instead of guessing.
//
// SAFETY: `name_locked = 1` rows are never touched — a name the user typed by hand outranks
// anything derived here (§Інваріанти «Ручна назва операції авторитетна»).
import type { Env } from "../../env.ts";

export interface TranslitFix {
  from: string;          // current (Cyrillic) merchant name
  to: string;            // Latin name it should carry
  n: number;             // how many transactions change
  source: "sibling" | "description"; // where `to` came from — shown in the preview
}

const HAS_CYRILLIC = /[а-яїієґё]/i;
const HAS_LATIN = /[a-z]/i;

/**
 * The longest alphabetic word of ≥4 characters — this project's ONE answer to "is this the same
 * merchant, roughly".
 *
 * It was written twice, byte for byte, here and in `ai/enrich.ts`, with a comment on each copy
 * promising they agree. They did, until someone changed one: the merchant-consensus categoriser,
 * the transliteration merge and (since 2026-08-13) "apply to similar operations" all decide the
 * same question, and two of them silently disagreeing would show up as an app that groups
 * operations one way and files them another. Exported so a fourth caller cannot start a third copy.
 *
 * Why the LONGEST word: a bank description is a merchant plus noise ("SILPO 4506 KYIV",
 * "Money transfers: 4441 11** **** 4932"), and the noise is short — numbers, city codes,
 * two-letter prefixes. The longest word survives the noise without needing to know the format.
 */
export function coreToken(raw: string | null): string | null {
  if (!raw) return null;
  const words = raw.toLowerCase()
    .replace(/[^a-zа-яїієґ0-9]+/gi, " ")
    .split(" ")
    .filter((w) => /[a-zа-яїієґ]/i.test(w) && w.length >= 4);
  if (!words.length) return null;
  return words.sort((a, b) => b.length - a.length)[0];
}

/** `SILPO 4506 KYIV` → `Silpo`. Bank descriptions are upper-case and carry a variable tail
 *  (store number, city), so we take the core token and title-case it — never the whole string. */
function nameFromDescription(desc: string): string | null {
  const core = coreToken(desc);
  if (!core || !HAS_LATIN.test(core)) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

interface Row { id: string; merchant: string | null; raw_json: string | null }

/**
 * Plan the rename. Read-only — `apply` is a separate step so the user sees what would change
 * (a rename touching hundreds of rows is not something to trigger blind).
 */
export async function planTranslitFixes(env: Env): Promise<TranslitFix[]> {
  const rows = await env.DB.prepare(
    `SELECT id, merchant, raw_json FROM transactions
     WHERE source = 'mono' AND merchant IS NOT NULL AND TRIM(merchant) <> ''
       AND COALESCE(name_locked, 0) = 0 AND raw_json IS NOT NULL`,
  ).all<Row>();

  // Latin names already in use, keyed by merchant root: the target vocabulary. Built from ALL
  // rows (including locked ones) — a hand-typed Latin name is exactly what we want to converge on.
  const latinByRoot = new Map<string, string>();
  const all = await env.DB.prepare(
    "SELECT merchant FROM transactions WHERE merchant IS NOT NULL AND TRIM(merchant) <> ''",
  ).all<{ merchant: string }>();
  for (const r of all.results ?? []) {
    if (HAS_CYRILLIC.test(r.merchant) || !HAS_LATIN.test(r.merchant)) continue;
    const root = coreToken(r.merchant);
    if (root && !latinByRoot.has(root)) latinByRoot.set(root, r.merchant.trim());
  }

  const byFrom = new Map<string, TranslitFix>();
  for (const r of rows.results ?? []) {
    const merchant = (r.merchant ?? "").trim();
    // Only rows the model transliterated: Cyrillic name over a Latin bank description.
    if (!merchant || !HAS_CYRILLIC.test(merchant)) continue;
    let desc: string | null = null;
    try { desc = (JSON.parse(r.raw_json ?? "{}") as { description?: string }).description?.trim() ?? null; }
    catch { desc = null; }
    if (!desc || !HAS_LATIN.test(desc) || HAS_CYRILLIC.test(desc)) continue;

    const root = coreToken(desc);
    const sibling = root ? latinByRoot.get(root) : undefined;
    const to = sibling ?? nameFromDescription(desc);
    if (!to || to === merchant) continue;

    const key = `${merchant}→${to}`;
    const hit = byFrom.get(key);
    if (hit) hit.n += 1;
    else byFrom.set(key, { from: merchant, to, n: 1, source: sibling ? "sibling" : "description" });
  }
  return [...byFrom.values()].sort((a, b) => b.n - a.n);
}

/**
 * Apply the plan. Renames the transactions AND the learned aliases that carry the same display
 * name — leaving the alias behind would re-apply the Cyrillic spelling to the next transaction
 * of that merchant, and the split history would grow back.
 */
export async function applyTranslitFixes(env: Env): Promise<{ fixed: number; merchants: number; aliases: number }> {
  const plan = await planTranslitFixes(env);
  let fixed = 0;
  let aliases = 0;
  for (const f of plan) {
    const tx = await env.DB.prepare(
      "UPDATE transactions SET merchant = ? WHERE merchant = ? AND COALESCE(name_locked, 0) = 0",
    ).bind(f.to, f.from).run();
    fixed += tx.meta.changes ?? 0;
    const al = await env.DB.prepare(
      "UPDATE merchant_aliases SET display_name = ? WHERE display_name = ? AND source = 'ai'",
    ).bind(f.to, f.from).run();
    aliases += al.meta.changes ?? 0;
  }
  return { fixed, merchants: plan.length, aliases };
}
