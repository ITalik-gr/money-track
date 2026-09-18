/**
 * §SEARCH-VEC — semantic search over operations (docs/PERIMETER.md).
 *
 * The network and the vector index are stubbed. What is worth testing here is not whether an
 * embedding model works — it does, and asserting that would be asserting somebody else's product —
 * but the three rules that make this safe to ship:
 *
 *   1. the exact result WINS and keeps its order; semantic hits are only ever appended;
 *   2. a query the text filter already answered costs no embedding call at all;
 *   3. nothing is indexed, and nothing leaves the Durable Object, until the user says so.
 *
 * Each of those is a decision that would be invisible if it regressed: a blended ranking still
 * returns rows, an always-on index still works, and the bill arrives a month later.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, type MemDb } from "./harness.ts";
import {
  embedText, textHash, hybridSearch, semanticEnabled, setSemanticEnabled, indexBatch,
} from "../lib/finance/search-vec.ts";

/** Counts what actually reached the model and the index. */
interface Spy { embeds: number; upserts: number; queries: number }

function envWith(db: MemDb, hits: { id: string; score: number }[] = [], spy?: Spy) {
  return {
    DB: db,
    USER_ID: "u1",
    AI: {
      run: async (_model: string, input: { text: string[] }) => {
        if (spy) spy.embeds += input.text.length;
        return { data: input.text.map(() => [0.1, 0.2, 0.3]) };
      },
    },
    TX_INDEX: {
      upsert: async (vectors: unknown[]) => { if (spy) spy.upserts += vectors.length; },
      deleteByIds: async () => {},
      query: async () => {
        if (spy) spy.queries++;
        return { matches: hits.map((h) => ({ id: `u1:${h.id}`, score: h.score, metadata: { tx_id: h.id } })) };
      },
    },
  } as never;
}

test("the embedded text carries the WORDS and never the money", () => {
  const text = embedText({
    id: "t1",
    merchant: "Веломаркет ПП",
    comment: null,
    user_note: "запчастина до велосипеда",
    ai_note: "bicycle part",
    raw_json: JSON.stringify({ description: "VELOMARKET PP KYIV" }),
  });
  assert.match(text, /Веломаркет/);
  assert.match(text, /запчастина/);
  assert.match(text, /VELOMARKET/);
  // No amount, no date, no account — and not only for the perimeter: a number embedded beside
  // words makes «450» and «455» look related, and this index is never asked about a sum.
  assert.doesNotMatch(text, /\d{3,}/);
});

test("a repeated name is not embedded twice", () => {
  // `merchant` is very often the raw description cleaned up. Repeating the same words in a short
  // string skews the vector toward them for no reason at all.
  const text = embedText({
    id: "t", merchant: "Silpo", comment: "Silpo", user_note: null, ai_note: null,
    raw_json: JSON.stringify({ description: "Silpo" }),
  });
  assert.equal(text, "Silpo");
});

test("the hash notices a changed NOTE and ignores an unchanged row", () => {
  // The whole point of hashing the text rather than watching `updated_at`: a transaction row is
  // rewritten by every enrichment and every sync, and almost none of those touch these words.
  const base = { id: "t", merchant: "АТБ", comment: null, ai_note: null, raw_json: null };
  assert.equal(textHash(embedText({ ...base, user_note: null })), textHash(embedText({ ...base, user_note: null })));
  assert.notEqual(textHash(embedText({ ...base, user_note: null })), textHash(embedText({ ...base, user_note: "подарунок" })));
});

test("a full page of exact matches costs NO embedding call", async () => {
  const spy: Spy = { embeds: 0, upserts: 0, queries: 0 };
  const env = envWith(migratedDb(), [{ id: "x1", score: 0.9 }], spy);
  const exact = ["a", "b", "c"];
  const out = await hybridSearch(env, "АТБ", exact, 3);
  assert.deepEqual(out.ids, exact);
  assert.deepEqual(out.semantic, []);
  assert.equal(spy.embeds, 0, "the text filter answered, so nothing was embedded");
  assert.equal(spy.queries, 0);
});

test("exact matches keep their order and semantic hits are APPENDED", async () => {
  const env = envWith(migratedDb(), [{ id: "sem1", score: 0.8 }, { id: "sem2", score: 0.7 }]);
  const out = await hybridSearch(env, "штука для велика", ["exact1"], 10);
  // Blending the two by score was the obvious design and is the wrong one: it would let «АТБ»
  // return «Сільпо» rows above actual АТБ ones, because to an embedding they are nearly the same.
  assert.deepEqual(out.ids, ["exact1", "sem1", "sem2"]);
  assert.deepEqual(out.semantic, ["sem1", "sem2"]);
});

test("a row the text filter already found is not repeated by the semantic half", async () => {
  const env = envWith(migratedDb(), [{ id: "exact1", score: 0.9 }, { id: "sem1", score: 0.8 }]);
  const out = await hybridSearch(env, "кава", ["exact1"], 10);
  assert.deepEqual(out.ids, ["exact1", "sem1"]);
});

test("a broken index degrades to the text result, it does not break search", async () => {
  const db = migratedDb();
  const env = {
    DB: db, USER_ID: "u1",
    AI: { run: async () => { throw new Error("Workers AI is down"); } },
    TX_INDEX: { query: async () => { throw new Error("no index"); } },
  } as never;
  const out = await hybridSearch(env, "щось", ["exact1"], 10);
  // The user loses the fallback, not the feature. A throw here would take the ordinary text
  // search down with it — the search box would stop working because a nice-to-have failed.
  assert.deepEqual(out.ids, ["exact1"]);
  assert.deepEqual(out.semantic, []);
});

test("nothing is indexed until the user switches it on", async () => {
  const db = migratedDb();
  assert.equal(await semanticEnabled(db), false, "off by default");
  await setSemanticEnabled(db, true);
  assert.equal(await semanticEnabled(db), true);
  await setSemanticEnabled(db, false);
  assert.equal(await semanticEnabled(db), false);
});

test("an indexed vector carries the id and NOT the text", async () => {
  const spy: Spy = { embeds: 0, upserts: 0, queries: 0 };
  const db = migratedDb();
  let captured: Record<string, unknown>[] = [];
  const env = {
    DB: db, USER_ID: "u1",
    AI: { run: async (_m: string, i: { text: string[] }) => ({ data: i.text.map(() => [0.1]) }) },
    TX_INDEX: { upsert: async (v: Record<string, unknown>[]) => { captured = v; spy.upserts += v.length; } },
  } as never;

  await indexBatch(env, [{
    id: "t1", merchant: "Веломаркет", comment: null, user_note: "для велика", ai_note: null, raw_json: null,
  }]);

  assert.equal(spy.upserts, 1);
  const v = captured[0]!;
  assert.equal(v.namespace, "u1", "the namespace is the USER — a shared space with a filter is one forgotten where away from a leak");
  assert.deepEqual(v.metadata, { tx_id: "t1" });
  // The index holds numbers and an id. Every figure is read back from the DO afterwards, so a
  // stale index can only ever MISS a row — it can never state a wrong amount.
  assert.equal(JSON.stringify(v).includes("Веломаркет"), false);
});
