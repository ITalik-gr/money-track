/**
 * §CSV-AI — a model's column mapping is re-parsed against the file before use: a swapped date/amount
 * mapping is valid JSON and plausible, so it must fail here, in code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mapStatementColumns } from "../lib/ai/statement-map.ts";
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

test("§CSV-AI: a swapped date/amount mapping is REFUSED, not imported", async () => {
  // Valid JSON, plausible shape, and catastrophic: this is the answer the guard exists for.
  const got = await withFetch(
    stubModel({ header_row: 2, date: 2, description: 1, amount: 0, currency: 3, comment: null, mcc: null }),
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
