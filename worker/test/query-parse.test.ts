/**
 * §QUERY-PARSE — the search box's grammar, table-driven, in both languages, with the ambiguous
 * cases pinned explicitly. The rule every row checks: a recognised piece becomes a filter AND a
 * chip; an unrecognised word stays in the text — nothing is silently dropped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, type ParseCategory } from "../lib/finance/query-parse.ts";
import { localWallTime, localMonthStart, localWeekStart } from "../lib/finance/time.ts";

// 2026-05-14 12:00 Kyiv — a Thursday in mid-May.
const NOW = Math.floor(Date.parse("2026-05-14T09:00:00Z") / 1000);
const CATS: ParseCategory[] = [
  { id: 1, name: "Продукти", parent_id: null },
  { id: 2, name: "Кафе", parent_id: null },
  { id: 21, name: "Кава", parent_id: 2 },
  { id: 3, name: "Транспорт", parent_id: null },
  { id: 4, name: "Groceries", parent_id: null },
];
const p = (q: string) => parseQuery(q, CATS, NOW);
const may2026: [number, number] = [localWallTime(2026, 5, 1), localWallTime(2026, 6, 1) - 1];

test("amounts: minimum, maximum, range — in both languages, currency words allowed", () => {
  assert.equal(p("понад 500").amin, 500);
  assert.equal(p("більше за 1 200 грн").amin, 1200);
  assert.equal(p("over 50$").amin, 50);
  assert.equal(p(">1000").amin, 1000);
  assert.equal(p("менше 300").amax, 300);
  assert.equal(p("under 20").amax, 20);
  const r = p("200–400");
  assert.deepEqual([r.amin, r.amax], [200, 400]);
  const r2 = p("400-200 ₴");
  assert.deepEqual([r2.amin, r2.amax], [200, 400], "a reversed range is still a range");
  assert.equal(p("понад 99,5").amin, 99.5);
});

test("«до 15 травня» is a date word, never «amount ≤ 15»", () => {
  const r = p("до 15 травня");
  assert.equal(r.amax, undefined);
});

test("periods: relative ones in Kyiv calendar terms", () => {
  const lm = p("минулого місяця");
  assert.deepEqual([lm.from, lm.to], [localMonthStart(NOW, -1), localMonthStart(NOW) - 1]);
  const tw = p("this week");
  assert.equal(tw.from, localWeekStart(NOW));
  assert.equal(p("за минулий квартал").from, localWallTime(2026, 1, 1));
  assert.equal(p("last year").from, localWallTime(2025, 1, 1));
});

test("a month name: its most recent occurrence that is not in the future", () => {
  assert.deepEqual([p("у травні").from, p("у травні").to], may2026);
  assert.deepEqual([p("in may").from, p("in may").to], may2026);
  // June has not happened yet in May 2026, so «червень» is June 2025.
  assert.equal(p("червень").from, localWallTime(2025, 6, 1));
  // An explicit year wins.
  assert.equal(p("травень 2024").from, localWallTime(2024, 5, 1));
  assert.equal(p("у 2025 році").from, localWallTime(2025, 1, 1));
});

test("categories: matched Cyrillic-folded, inflected, the longest name wins; a sub-category stays a leaf", () => {
  assert.equal(p("продукти").catparent, 1);
  assert.equal(p("ПРОДУКТАХ").catparent, 1, "case and inflection");
  assert.equal(p("кава").category, 21, "a leaf is filtered as a leaf");
  assert.equal(p("groceries").catparent, 4);
});

test("exclusions: «без X», «except X» and «-X»; the excluded word is not searched", () => {
  const r = p("кафе без Starbucks");
  assert.deepEqual(r.exclude, ["Starbucks"]);
  assert.equal(r.catparent, 2);
  assert.equal(r.text, null);
  assert.deepEqual(p("coffee -starbucks").exclude, ["starbucks"]);
});

test("flow: income and spending words", () => {
  assert.equal(p("доходи цього року").type, "income");
  assert.equal(p("витрати").type, "expense");
});

test("the whole sentence: every piece a chip, nothing dropped", () => {
  const r = p("кава понад 200 у травні без Starbucks");
  assert.equal(r.category, 21);
  assert.equal(r.amin, 200);
  assert.deepEqual([r.from, r.to], may2026);
  assert.deepEqual(r.exclude, ["Starbucks"]);
  assert.equal(r.text, null);
  assert.deepEqual(r.chips.map((c) => c.kind).sort(), ["amount", "category", "exclude", "period"]);
});

test("what it does not understand stays text — a merchant name is not a filter", () => {
  const r = p("Rozetka понад 1000");
  assert.equal(r.text, "Rozetka");
  assert.equal(r.amin, 1000);
  const plain = p("Сільпо");
  assert.equal(plain.text, "Сільпо");
  assert.deepEqual(plain.chips, []);
});

// ---- through the real route, on the seeded ledger ----------------------------
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { TxRow, ParsedQuery } from "../../shared/api/transactions.ts";

async function feed(db: ReturnType<typeof migratedDb>, qs: string): Promise<TxRow[]> {
  const res = await api.request(`/transactions?limit=200&${qs}`, { method: "GET" }, testEnv(db));
  assert.equal(res.status, 200);
  return await res.json() as TxRow[];
}

test("§CYR-CASE in the feed: «сільпо» finds «Сільпо» (a bare LIKE never did)", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb(); seed(db);
    const all = (await feed(db, "")).filter((r) => r.merchant === "Сільпо");
    assert.ok(all.length > 0, "the fixture has Сільпо");
    const found = await feed(db, `q=${encodeURIComponent("сільпо")}`);
    assert.equal(found.filter((r) => r.merchant === "Сільпо").length, all.length);
  } finally { restore(); }
});

test("smart=1 applies what the box understood: an amount bound and an exclusion", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb(); seed(db);
    const big = await feed(db, `smart=1&q=${encodeURIComponent("понад 1000")}`);
    assert.ok(big.length > 0);
    for (const r of big) assert.ok(Math.abs(r.amount) >= 1000_00, `${r.merchant} ${r.amount}`);
    const noSilpo = await feed(db, `smart=1&q=${encodeURIComponent("без сільпо")}`);
    assert.ok(noSilpo.length > 0);
    assert.ok(noSilpo.every((r) => r.merchant !== "Сільпо"), "the excluded merchant is gone, Cyrillic-folded");
    // And the parse endpoint reports the same pieces as chips.
    const res = await api.request(`/transactions/parse?q=${encodeURIComponent("понад 1000 без сільпо")}`, { method: "GET" }, testEnv(db));
    const parsed = await res.json() as ParsedQuery;
    assert.deepEqual(parsed.chips.map((c) => c.kind).sort(), ["amount", "exclude"]);
  } finally { restore(); }
});
