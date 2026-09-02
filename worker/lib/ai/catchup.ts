/**
 * §AI-CATCHUP — the daily second look at operations the app could obviously have filed, and did not.
 *
 * The owner's case, in full: «Списання відсотків за серпень», MCC 6012, sitting in «Перекази і
 * зняття» with no real category, while FOUR operations of the same meaning («Відсотки по кредиту»,
 * «Списання відсотків за травень», …) were already filed under a category he has. Nothing had
 * fired, and every step had behaved correctly:
 *
 *  • the MCC rule answered 6012 → bucket 13, which is the right answer to "what kind of banking
 *    operation is this" and no answer at all to "where did the money go". `real_category_id` is
 *    the field for the second question and nothing filled it automatically;
 *  • merchant consensus (≥3 charges under one root, ≥80% agreeing) never fired either, because the
 *    bank rewords the description every month («за серпень», «за травень», «Відсотки по кредиту»),
 *    so `coreToken` produced a different root each time. That is exactly the case §SUB-FIND fixed
 *    for SEARCH — by widening the haystack — and the widening had not reached categorisation.
 *
 * What this file adds is not a new categoriser. It is the pass that notices a GAP and asks once,
 * for everything at once.
 *
 * ⚠️ **ONE call per BATCH, never per transaction.** `categorizeTransfers` already walks bucket 13
 * one row at a time, each its own model call, driven by a button. That is the right shape for
 * "I am looking at this screen now" and the wrong one for a nightly pass: the same work becomes a
 * per-transaction tax on an account that mostly has nothing to fix.
 *
 * ⚠️ **The model is given the FULL haystack** (`txHaystack` — merchant + the bank's raw description
 * + comment + `ai_note`), because the answer to the owner's case is literally in the description
 * the bank wrote, and `merchant` is the one field that had been rewritten by enrichment.
 *
 * ⚠️ **"I don't know" is a first-class answer** (`category_id: null`), and the prompt says so. A
 * wrong category filed silently is worse than a gap: the gap is visible on the screen and in the
 * feed's «10 операцій без категорії», while a plausible wrong answer is not visible anywhere.
 *
 * ⚠️ **Nothing already decided is touched.** Only rows with NO category, or bucket-13 rows with no
 * `real_category_id`, are ever selected — the same rule as §RULES-UI apply and §SIMILAR: the app
 * does not silently argue with work that has already been done.
 *
 * ⚠️ Everything written goes through §AI-AUDIT, so a bad pass is one click from being undone.
 */
import type { Env } from "../../env.ts";
import { callHaikuJson } from "./json.ts";
import { buildSystemPrefix } from "./prompt.ts";
import { MODEL_FAST } from "./models.ts";
import { logUsage } from "./cost.ts";
import { txHaystack } from "../finance/plan-match.ts";
import { TRANSFER_CAT } from "./enrich.ts";
import { logChange } from "../../repo/ai-changes.ts";

/** How many operations one pass may look at. */
const BATCH = 25;
/**
 * How far back to look. A gap older than this is not something a nightly pass should be quietly
 * filling: the person has had it on their screen for two months and left it, and a sweep that
 * keeps reaching further back re-decides the same rows every night for free-looking money.
 */
const WINDOW_DAYS = 45;

interface Candidate {
  id: string;
  merchant: string | null;
  comment: string | null;
  description: string | null;
  ai_note: string | null;
  mcc: number | null;
  amount: number;
  currency_code: number;
  time: number;
  /** `true` when the row sits in bucket 13 and the question is `real_category_id`, not `category_id`. */
  is_transfer_bucket: number;
  category_id: number | null;
  real_category_id: number | null;
}

/**
 * The gaps, both kinds, in one query.
 *
 * `json_extract(raw_json, '$.description')` is the bank's ORIGINAL wording — the same source
 * §RULES-UI matches its text rules against, and deliberately not `merchant`, which AI enrichment
 * rewrites into a clean brand name. In the owner's case the clean name is what hid the answer.
 */
const CANDIDATES = `
  SELECT t.id, t.merchant, t.comment, t.ai_note, t.mcc, t.amount, t.currency_code, t.time,
         t.category_id, t.real_category_id,
         json_extract(t.raw_json, '$.description') AS description,
         CASE WHEN COALESCE(c.parent_id, t.category_id) = ${TRANSFER_CAT} THEN 1 ELSE 0 END AS is_transfer_bucket
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.amount < 0
    AND t.transfer_pair_id IS NULL
    AND t.time >= ?
    AND (
      t.category_id IS NULL
      OR (COALESCE(c.parent_id, t.category_id) = ${TRANSFER_CAT} AND t.real_category_id IS NULL)
    )`;

export async function catchupCandidates(env: Env, now: number): Promise<Candidate[]> {
  const since = now - WINDOW_DAYS * 86400;
  const r = await env.DB.prepare(`${CANDIDATES} ORDER BY t.time DESC LIMIT ${BATCH}`)
    .bind(since).all<Candidate>();
  return r.results ?? [];
}

interface Verdict { id: string; category_id: number | null }
interface CatchupAnswer { results?: Verdict[] }

/**
 * Ask once, about all of them.
 *
 * The task text names the two questions separately, because they are: a row with no category is
 * being classified, while a bucket-13 row already HAS a correct classification and is being asked
 * what the money was actually for. Handing the model one instruction for both is how «зняв
 * готівку» would come back as «Перекази» — a true statement that fills nothing.
 */
async function askBatch(env: Env, rows: Candidate[]): Promise<{ verdicts: Verdict[] }> {
  const system = await buildSystemPrefix(
    env,
    "you are given a batch of operations the app FAILED to file. For EACH one, name the category id " +
      "it belongs to. Two kinds are mixed in and `question` says which: `category` means the " +
      "operation has no category at all — classify it; `real_category` means the operation is a " +
      "transfer or a cash withdrawal that is correctly filed as such, and the question is what the " +
      "money was actually SPENT on (so never answer with the transfers category itself — for that " +
      "one, answer null). " +
      // Without this sentence the batch comes back complete and confident, which is the failure
      // mode that matters here: a plausible wrong category is invisible, a gap is not.
      "ANSWER null WHENEVER YOU ARE NOT SURE. A gap the person can see and fix is much better than " +
      "a wrong category filed silently, and you are not being scored on how many you fill. " +
      "The `text` field is everything the app knows about the operation, including the bank's own " +
      "raw wording — read it, the answer is usually there. " +
      "Return JSON {results: [{id, category_id}]} with one entry per operation, ids exactly as given.",
    true,   // the cached guide: this pass runs daily with an identical prefix, which is what the cache is for
  );

  const payload = rows.map((t) => ({
    id: t.id,
    question: t.is_transfer_bucket ? "real_category" : "category",
    text: txHaystack(t).replace(/\s+/g, " ").trim().slice(0, 300),
    mcc: t.mcc,
    amount: Math.round(t.amount / 100),
    currency_code: t.currency_code,
  }));

  const { result, usage } = await callHaikuJson<CatchupAnswer>(
    env, system,
    [{ type: "text", text: `Operations:\n${JSON.stringify(payload)}` }],
    // Haiku by policy, like every bulk pass (enrich/OCR/parse): this is high-volume, low-stakes
    // classification, and the interesting half of the answer is the model saying "not sure".
    2048, MODEL_FAST,
  );
  logUsage("catchup", usage);
  return { verdicts: result.results ?? [] };
}

export interface CatchupResult { looked: number; filled: number; unsure: number }

/**
 * One pass. Safe to run on an account with nothing to do — it costs one indexed query and returns.
 */
export async function runCatchup(env: Env, now = Math.floor(Date.now() / 1000)): Promise<CatchupResult> {
  const rows = await catchupCandidates(env, now);
  if (!rows.length) return { looked: 0, filled: 0, unsure: 0 };

  const { verdicts } = await askBatch(env, rows);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // §FK-GUARD: every category id the model returns is validated before it reaches a write. The id
  // range has holes from deleted categories, so a plausible id lands on no row and the UPDATE dies
  // with a foreign-key error the person only sees as "не вдалось".
  const wanted = [...new Set(verdicts.map((v) => v.category_id).filter((x): x is number => typeof x === "number"))];
  const known = new Set<number>();
  if (wanted.length) {
    const r = await env.DB.prepare(
      `SELECT id FROM categories WHERE id IN (${wanted.map(() => "?").join(",")}) AND is_income = 0`,
    ).bind(...wanted).all<{ id: number }>();
    for (const row of r.results ?? []) known.add(row.id);
  }

  let filled = 0, unsure = 0;
  for (const v of verdicts) {
    const row = byId.get(v.id);
    if (!row) continue;                                   // an id we never asked about
    if (v.category_id == null || !known.has(v.category_id)) { unsure++; continue; }
    // Filing a transfer as the transfers category answers the question with the question.
    if (row.is_transfer_bucket && v.category_id === TRANSFER_CAT) { unsure++; continue; }

    const field = row.is_transfer_bucket ? "real_category_id" : "category_id";
    const before = row.is_transfer_bucket ? row.real_category_id : row.category_id;
    // Re-checking emptiness inside the UPDATE, not just in the SELECT: the batch is a round trip
    // to a model, and a person editing that very row meanwhile must win. Same rule as §AI-AUDIT's
    // revert refusing a field that has moved on.
    const res = await env.DB.prepare(
      `UPDATE transactions SET ${field} = ? WHERE id = ? AND ${field} IS NULL`,
    ).bind(v.category_id, v.id).run();
    if (!res.meta.changes) continue;

    await logChange(env.DB, v.id, field, before, v.category_id, "catchup", now);
    filled++;
  }
  return { looked: rows.length, filled, unsure };
}

/** How many gaps are waiting — for the caller that wants to skip the pass entirely. */
export async function catchupPending(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${CANDIDATES})`)
    .bind(now - WINDOW_DAYS * 86400).first<{ n: number }>();
  return r?.n ?? 0;
}
