/**
 * §SEARCH-VEC — semantic search over operations: «коли я купував ту штуку для велика».
 *
 * WHAT IT IS FOR. The text filter answers «find the rows containing this word», which is the
 * wrong question whenever the person cannot remember the word. A bike part bought at a shop whose
 * name says nothing about bikes is invisible to `LIKE` and always will be.
 *
 * WHAT IT IS NOT. It does not replace the text filter, and it never wins over it — see
 * `hybridSearch`. Exact matching is right nearly always and is free; this is the fallback for the
 * cases where being roughly right is the only way to be useful at all.
 *
 * ⚠️ PERIMETER (docs/PERIMETER.md §SEARCH-VEC). The text of an operation leaves the Durable Object
 * to be embedded — the first time anything in this project does. It goes to Workers AI and the
 * vector goes to Vectorize: both Cloudflare's own, the same infrastructure that already holds D1,
 * R2 and the DO, so NO new third party learns where this person buys food. That is why the model
 * is `@cf/baai/bge-m3` and not a better-scoring external API.
 *
 * ⚠️ Vectorize is an INDEX, not a store. It holds 1024 numbers and a `tx_id`; the text itself is
 * never written there. Drop the whole index and nothing in the app changes except that this
 * fallback stops answering until it is rebuilt.
 */
import type { Env } from "../../env.ts";
import type { AppDb } from "../platform/db-shim.ts";

/** Multilingual, 1024 dimensions — the index is created with that width (wrangler.jsonc). */
const MODEL = "@cf/baai/bge-m3";

export interface IndexableTx {
  id: string;
  merchant: string | null;
  comment: string | null;
  user_note: string | null;
  ai_note: string | null;
  raw_json: string | null;
}

/**
 * The text that represents one operation.
 *
 * ⚠️ NO AMOUNT, NO DATE, NO ACCOUNT. Not only for the perimeter: a number embedded next to words
 * makes «450» and «455» look related, and the question this index answers is never about a sum —
 * amounts and dates are exactly what the deterministic filters already do perfectly.
 *
 * `ai_note` is included because it is often the only place the PURPOSE is written down: the model
 * wrote «запчастина до велосипеда» under a shop called «Веломаркет ПП». That note is the reason
 * this feature can work at all on a Ukrainian ledger.
 */
export function embedText(tx: IndexableTx): string {
  let desc: string | null = null;
  try { desc = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description ?? null : null; }
  catch { desc = null; }
  return [tx.merchant, desc, tx.comment, tx.user_note, tx.ai_note]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    // De-duplicated: `merchant` is very often the raw description cleaned up, and repeating the
    // same words twice in a short string skews the vector toward them for no reason.
    .filter((p, i, all) => all.indexOf(p) === i)
    .join(" · ")
    .slice(0, 1000);
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = await env.AI.run(MODEL, { text: texts }) as { data: number[][] };
  return res.data ?? [];
}

/**
 * Index a batch of operations.
 *
 * ⚠️ The namespace is the USER, not a metadata field. A shared space with a `where` clause is one
 * forgotten filter away from putting somebody else's purchase in this person's results — the same
 * lesson §D1 bought for Telegram, and one that is much harder to notice here, because a wrong
 * neighbour in a semantic result just looks like a bad match.
 */
export async function indexBatch(env: Env, rows: IndexableTx[]): Promise<number> {
  const withText = rows.map((r) => ({ r, text: embedText(r) })).filter((x) => x.text.length > 2);
  if (!withText.length) return 0;

  const vectors = await embed(env, withText.map((x) => x.text));
  if (vectors.length !== withText.length) return 0;

  await env.TX_INDEX.upsert(withText.map((x, i) => ({
    id: `${env.USER_ID}:${x.r.id}`,
    values: vectors[i]!,
    namespace: env.USER_ID,
    // The id, and nothing else. Every figure is read back from the DO afterwards, so a stale or
    // dropped index can never state a wrong amount — the worst it can do is miss a row.
    metadata: { tx_id: x.r.id },
  })));
  return withText.length;
}


export interface SemanticHit { id: string; score: number }

/**
 * The nearest operations to a natural-language query.
 *
 * `minScore` exists because a vector index ALWAYS returns its k nearest neighbours, however far
 * away they are. Without a floor, «коли я купував запчастину до велосипеда» on a ledger with no
 * bicycle in it returns five confident groceries — which is worse than an empty result, because
 * an empty result is understood and a wrong one is acted on.
 */
export async function semanticSearch(
  env: Env, query: string, limit = 20, minScore = 0.45,
): Promise<SemanticHit[]> {
  const text = query.trim();
  if (text.length < 3) return [];
  const [vec] = await embed(env, [text]);
  if (!vec) return [];

  const res = await env.TX_INDEX.query(vec, {
    topK: Math.min(limit, 50),
    namespace: env.USER_ID,
    returnMetadata: "indexed",
  });
  return (res.matches ?? [])
    .filter((m) => m.score >= minScore)
    .map((m) => ({ id: String(m.metadata?.tx_id ?? m.id.split(":").pop()), score: m.score }));
}

/**
 * §SEARCH-VEC — the HYBRID rule, and the whole reason this is safe to ship.
 *
 * The deterministic filter runs first and its result is returned WHOLE and in its own order.
 * Semantic ids are appended only for what it did not find. Blending the two by score was the
 * obvious design and is the wrong one: it would let «АТБ» start returning «Сільпо» rows above
 * actual АТБ ones, because to an embedding those two are nearly the same thing. They are not the
 * same thing to somebody looking for a receipt.
 *
 * So: exact matches keep their place, semantic ones are clearly extra, and a query that the text
 * filter already answered costs no embedding call at all.
 */
export async function hybridSearch(
  env: Env, query: string, exactIds: string[], limit: number,
): Promise<{ ids: string[]; semantic: string[] }> {
  if (exactIds.length >= limit) return { ids: exactIds.slice(0, limit), semantic: [] };
  let hits: SemanticHit[] = [];
  try {
    hits = await semanticSearch(env, query, limit);
  } catch {
    // The index being unavailable must never break search. The user loses the fallback, not the
    // feature — and a thrown error here would take down the ordinary text search with it.
    return { ids: exactIds, semantic: [] };
  }
  const seen = new Set(exactIds);
  const extra = hits.map((h) => h.id).filter((id) => id && !seen.has(id));
  return { ids: [...exactIds, ...extra].slice(0, limit), semantic: extra };
}

// ─── keeping the index in step ──────────────────────────────────────────────────────────────────

/** FNV-1a over the embed text: short, stable, and enough to notice that the words changed. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export async function markIndexed(db: AppDb, rows: { id: string; hash: string }[], now: number): Promise<void> {
  for (const r of rows) {
    await db.prepare(
      `INSERT INTO tx_search_index (tx_id, text_hash, indexed_at) VALUES (?, ?, ?)
       ON CONFLICT(tx_id) DO UPDATE SET text_hash = excluded.text_hash, indexed_at = excluded.indexed_at`,
    ).bind(r.id, r.hash, now).run();
  }
}

export interface IndexProgress { indexed: number; remaining: number }

/**
 * One pass of the backfill: embed a batch, record what was indexed, report what is left.
 *
 * A batch per call, with the caller repeating — the same shape as `enrichPending`. A whole
 * ledger in one request is a handler that gets killed halfway with no record of how far it got,
 * and the next attempt starts from the beginning.
 */
export async function indexPending(env: Env, limit = 50): Promise<IndexProgress> {
  const rows = await pendingRows(env.DB, limit);
  let indexed = 0;
  if (rows.length) {
    indexed = await indexBatch(env, rows);
    if (indexed) {
      await markIndexed(
        env.DB,
        rows.map((r) => ({ id: r.id, hash: textHash(embedText(r)) })),
        Math.floor(Date.now() / 1000),
      );
    }
  }
  return { indexed, remaining: await pendingCount(env.DB) };
}

/**
 * Rows that need (re)indexing: never-indexed first, then recent rows whose WORDS changed.
 *
 * Two queries rather than one scan, because they answer different questions. «Never indexed» is
 * the backfill and is exact and cheap. «Changed since» can only be settled by rebuilding the text
 * in JS — `embedText` assembles it, and a second assembly in SQL would be a copy that drifts the
 * first time a field joins the list — so it is bounded to the recent window, which is the only
 * part of a ledger whose words actually move (an enrichment, a renamed merchant, a new note).
 */
async function pendingRows(db: AppDb, limit: number): Promise<IndexableTx[]> {
  const fresh = await db.prepare(
    `SELECT t.id, t.merchant, t.comment, t.user_note, t.ai_note, t.raw_json
     FROM transactions t LEFT JOIN tx_search_index x ON x.tx_id = t.id
     WHERE x.tx_id IS NULL
     ORDER BY t.time DESC LIMIT ?`,
  ).bind(limit).all<IndexableTx>();
  const rows = fresh.results ?? [];
  if (rows.length >= limit) return rows;

  const recent = await db.prepare(
    `SELECT t.id, t.merchant, t.comment, t.user_note, t.ai_note, t.raw_json, x.text_hash AS hash
     FROM transactions t JOIN tx_search_index x ON x.tx_id = t.id
     ORDER BY t.time DESC LIMIT 200`,
  ).all<IndexableTx & { hash: string | null }>();
  const changed = (recent.results ?? []).filter((r) => r.hash !== textHash(embedText(r)));
  return [...rows, ...changed].slice(0, limit);
}

/**
 * How many are still un-indexed.
 *
 * Counts the never-indexed only, deliberately. That is what «remaining» means to somebody
 * watching a backfill, and the alternative — re-hashing every row in the ledger on every poll —
 * would make a progress bar the most expensive query in the app.
 */
async function pendingCount(db: AppDb): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM transactions t
     LEFT JOIN tx_search_index x ON x.tx_id = t.id WHERE x.tx_id IS NULL`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── the feed integration ───────────────────────────────────────────────────────────────────────

const ENABLED_KEY = "search_semantic";

/**
 * Switched OFF until the person turns it on (docs/PERIMETER.md §SEARCH-VEC).
 *
 * Indexing somebody's whole history quietly, on the grounds that it never leaves Cloudflare, would
 * still be deciding about their data for them. It also costs: every un-indexed ledger would start
 * embedding itself the first time the feature shipped.
 */
export async function semanticEnabled(db: AppDb): Promise<boolean> {
  const { getState } = await import("./repo.ts");
  return (await getState(db, ENABLED_KEY)) === "1";
}

export async function setSemanticEnabled(db: AppDb, on: boolean): Promise<void> {
  const { setState } = await import("./repo.ts");
  await setState(db, ENABLED_KEY, on ? "1" : "0");
}

/**
 * Append semantic hits to a feed page that the text filter under-filled.
 *
 * ⚠️ Only when the exact search came back SHORT. A query the text filter already answered costs no
 * embedding call at all — which is both the cost control and the correctness rule: «АТБ» must
 * never start returning «Сільпо» rows just because an embedding finds the two similar.
 */
export async function appendSemantic(
  env: Env, locale: Parameters<typeof import("../../repo/transactions.ts").listFeedByIds>[1],
  q: string, rows: { id: string }[], limit: number,
): Promise<{ rows: unknown[]; semantic_ids: string[] }> {
  if (!q.trim() || rows.length >= limit || !(await semanticEnabled(env.DB))) {
    return { rows, semantic_ids: [] };
  }
  const { semantic } = await hybridSearch(env, q, rows.map((r) => r.id), limit);
  if (!semantic.length) return { rows, semantic_ids: [] };
  const txRepo = await import("../../repo/transactions.ts");
  const extra = await txRepo.listFeedByIds(env.DB, locale, semantic);
  return { rows: [...rows, ...extra], semantic_ids: semantic };
}
