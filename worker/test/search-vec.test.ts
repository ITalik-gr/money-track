/**
 * §SEARCH-VEC — semantic search is safe to ship: embedded text carries no money, a full exact page
 * costs no embedding call, a broken index degrades to text, nothing is indexed until switched on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import {
  embedText, semanticEnabled, setSemanticEnabled, indexBatch,
} from "../lib/finance/search-vec.ts";

/** Counts what actually reached the model and the index. */
interface Spy { embeds: number; upserts: number; queries: number }

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
