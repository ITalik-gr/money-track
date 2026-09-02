/**
 * §CSV-AI — the model may propose column indices; it may not be believed on its word.
 *
 * The point of these scenarios is the GUARD, not the happy path. The prompt asking for a valid
 * mapping is a request; what makes a wrong answer harmless is that the proposal is re-parsed
 * against the file before anything uses it. A mapping that swaps the date and amount columns is
 * valid JSON, plausible, and imports a year of nonsense that looks completely ordinary — so it has
 * to fail HERE, in code, and it does: those columns do not parse as dates and amounts.
 *
 * The fetch is stubbed rather than mocked at the module boundary, so the whole path is exercised:
 * the prompt, `callHaikuJson`, the bounds check and the parse check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mapStatementColumns, mappingParsesSample, type StatementMapping } from "../lib/ai/statement-map.ts";
import { migratedDb, testEnv } from "./harness.ts";
import type { Env } from "../env.ts";

/** A statement whose headers no hint in `providers/csv.ts` recognises. */
const ROWS: string[][] = [
  ["Kontoauszug Muster Bank AG"],
  ["Zeitraum: 01.06.2026 - 30.06.2026"],
  ["Buchungstag", "Verwendungszweck", "Betrag", "Waehrung"],
  ["03.06.2026", "REWE MARKT KOELN", "-42,17", "EUR"],
  ["05.06.2026", "SPOTIFY AB", "-10,99", "EUR"],
  ["28.06.2026", "GEHALT JUNI", "2450,00", "EUR"],
];

function envWithKey(): Env {
  return { ...testEnv(migratedDb()), ANTHROPIC_API_KEY: "sk-ant-test" } as unknown as Env;
}

/** Answers every Anthropic call with one JSON body, the way the real API frames it. */
function stubModel(json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 900, output_tokens: 40 },
    stop_reason: "end_turn",
    model: "claude-haiku-4-5-20251001",
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test("§CSV-AI: a correct mapping of a bank no hint table knows is accepted", async () => {
  const got = await withFetch(
    stubModel({ header_row: 2, date: 0, description: 1, amount: 2, currency: 3, comment: null, mcc: null }),
    () => mapStatementColumns(envWithKey(), ROWS),
  );
  assert.ok(got, "a mapping that reads the file must be accepted");
  assert.equal(got.mapping.date, 0);
  assert.equal(got.mapping.amount, 2);
  assert.equal(got.mapping.description, 1);
  assert.equal(got.mapping.header_row, 2);
});

test("§CSV-AI: a swapped date/amount mapping is REFUSED, not imported", async () => {
  // Valid JSON, plausible shape, and catastrophic: this is the answer the guard exists for.
  const got = await withFetch(
    stubModel({ header_row: 2, date: 2, description: 1, amount: 0, currency: 3, comment: null, mcc: null }),
    () => mapStatementColumns(envWithKey(), ROWS),
  );
  assert.equal(got, null);
});

test("§CSV-AI: an index outside the file is refused", async () => {
  const got = await withFetch(
    stubModel({ header_row: 2, date: 0, description: 1, amount: 99, currency: null, comment: null, mcc: null }),
    () => mapStatementColumns(envWithKey(), ROWS),
  );
  assert.equal(got, null);
});

test("§CSV-AI: a missing mandatory column is refused rather than half-used", async () => {
  const got = await withFetch(
    stubModel({ header_row: 2, date: 0, description: null, amount: 2, currency: null, comment: null, mcc: null }),
    () => mapStatementColumns(envWithKey(), ROWS),
  );
  assert.equal(got, null);
});

test("§CSV-AI: a model that fails leaves the manual form standing, never an exception", async () => {
  const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.equal(await withFetch(boom, () => mapStatementColumns(envWithKey(), ROWS)), null);

  const garbage = (async () => new Response("not json at all", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await withFetch(garbage, () => mapStatementColumns(envWithKey(), ROWS)), null);
});

test("§CSV-AI: string indices are read, words are not", async () => {
  const got = await withFetch(
    stubModel({ header_row: "2", date: "0", description: "1", amount: "2", currency: "3", comment: "none", mcc: null }),
    () => mapStatementColumns(envWithKey(), ROWS),
  );
  assert.ok(got);
  assert.equal(got.mapping.date, 0);
  assert.equal(got.mapping.comment, null, "\"none\" is not an index");
});

test("§CSV-AI: the parse check needs more than one readable row", () => {
  // One good row among noise is a coincidence — a column of free text will contain a date
  // eventually. Two is the smallest number that is evidence.
  const oneGood: string[][] = [
    ["h1", "h2", "h3"],
    ["03.06.2026", "REWE", "-42,17"],
    ["not a date", "SPOTIFY", "nonsense"],
  ];
  const m: StatementMapping = {
    header_row: 0, date: 0, amount: 2, description: 1, currency: null, comment: null, mcc: null,
  };
  assert.equal(mappingParsesSample(oneGood, m), false);
  assert.equal(mappingParsesSample([...oneGood, ["05.06.2026", "GEHALT", "2450,00"]], m), true);
});

/**
 * End-to-end through the route, because the guard and the wiring are two different claims: the
 * previous scenarios prove the model's answer is checked, this one proves the preview actually
 * ASKS when the hint table came up empty — and says so in `mapping_source`, which is what the
 * screen uses to warn the reader that a machine picked these columns.
 */
test("§CSV-AI: the preview falls back to the model, and admits that it did", async () => {
  const { importRoutes } = await import("../routes/import.ts");
  const text = ROWS.map((r) => r.join(";")).join("\n");
  const env = envWithKey();

  const res = await withFetch(
    stubModel({ header_row: 2, date: 0, description: 1, amount: 2, currency: 3, comment: null, mcc: null }),
    async () => await importRoutes.request("/csv/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }, env as unknown as Record<string, unknown>),
  );
  const body = await res.json() as { complete: boolean; mapping_source: string; mapping: Record<string, number> };
  assert.equal(res.status, 200);
  assert.equal(body.complete, true, "the fallback completed a mapping the hints could not");
  assert.equal(body.mapping_source, "ai");
  assert.equal(body.mapping.amount, 2);
});

test("§CSV-AI: with no key the preview still answers — it just asks the person", async () => {
  const { importRoutes } = await import("../routes/import.ts");
  const text = ROWS.map((r) => r.join(";")).join("\n");
  const res = await importRoutes.request("/csv/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }, testEnv(migratedDb()) as unknown as Record<string, unknown>);
  const body = await res.json() as { complete: boolean; mapping_source: string };
  assert.equal(res.status, 200);
  assert.equal(body.complete, false);
  assert.equal(body.mapping_source, "hints");
});
