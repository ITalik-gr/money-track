/**
 * docs/JEV.md phase 4 — the machinery around the Jev calls outside enrich.
 *
 * `fetch` is stubbed; whether Jev is RIGHT is `scripts/eval-sites.mjs`'s job. Pinned here is what
 * no eval run would notice going wrong: which way each site falls back, what a probability becomes
 * on the screen, and that an answer can only ever be one of OUR options.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { judgeSubs, SUB_AT, NOT_AT } from "../lib/ai/judge-subs.ts";
import { judgeRealCategory } from "../lib/ai/judge-spend.ts";
import { judgeColumns } from "../lib/ai/judge-columns.ts";
import type { Env } from "../env.ts";
import type { RecurringCandidate } from "../../shared/api/planning.ts";

function env(over: Partial<Env> = {}): Env {
  return { DB: migratedDb(), USER_ID: "u1", IS_OWNER: true, JEV_API_KEY: "k", AI_JUDGE: "jev", ...over } as unknown as Env;
}

type Answer = Record<string, unknown>;
/** Answer each request by calling `reply` with its question map; record what was asked. */
function stub(reply: (q: Record<string, { criteria?: Record<string, unknown> }>, state: Record<string, unknown>) => Answer | null) {
  const real = globalThis.fetch;
  const asked: string[][] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push(Object.keys(body.questions));
    const answers = reply(body.questions, body.state);
    if (!answers) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 20 } }));
  }) as typeof fetch;
  return { asked, restore: () => { globalThis.fetch = real; } };
}
const choice = (c: string, p = 0.9) => ({ type: "choice", choice: c, probabilities: { [c]: p }, confidence: p });

const cand = (merchant: string): RecurringCandidate =>
  ({ merchant, amount: 41900, currency_code: 980, n: 6, months: 6, avg_interval_days: 30 }) as unknown as RecurringCandidate;

// ─── §SUB-REVIEW ────────────────────────────────────────────────────────────────────────────────

test("subs: a probability becomes one of three verdicts at the measured lines", async () => {
  const p: Record<string, number> = { Netflix: SUB_AT + 0.1, Фора: NOT_AT - 0.1, Middle: (SUB_AT + NOT_AT) / 2 };
  const s = stub((_q, state) => ({
    bill: { type: "noul", noul: p[String(state.merchant)] },
    kind: choice(state.merchant === "Netflix" ? "streaming" : "grocery"),
  }));
  try {
    const out = await judgeSubs(env(), [cand("Netflix"), cand("Фора"), cand("Middle")]);
    assert.deepEqual(out?.map((v) => v.verdict), ["subscription", "not", "unsure"]);
    // The reason is OUR label in the reader's language — Jev writes nothing a person reads.
    assert.equal(out?.[0].reason, "стрімінговий сервіс");
    assert.equal(s.asked.length, 3, "one request per merchant — no merchant reads another's state");
  } finally { s.restore(); }
});

test("subs: one failed request hands the WHOLE batch to Claude", async () => {
  const s = stub((_q, state) => state.merchant === "Down" ? null : { bill: { type: "noul", noul: 0.9 }, kind: choice("streaming") });
  try {
    assert.equal(await judgeSubs(env(), [cand("Netflix"), cand("Down")]), null);
  } finally { s.restore(); }
});

test("subs: Jev off → null, and nothing is sent", async () => {
  const s = stub(() => ({}));
  try {
    assert.equal(await judgeSubs(env({ AI_JUDGE: "haiku" }), [cand("Netflix")]), null);
    assert.equal(s.asked.length, 0);
  } finally { s.restore(); }
});

// ─── §F2 real category ──────────────────────────────────────────────────────────────────────────

test("transfers: the transfer bucket is never offered, and «own money» means no category", async () => {
  let offered: string[] = [];
  const s = stub((q) => {
    offered = Object.keys(q.real.criteria ?? {});
    return { real: choice("Own money moving", 0.95) };
  });
  try {
    const r = await judgeRealCategory(env(), { merchant: "Переказ на власну картку", comment: null, mcc: 4829, amount: -500000, currency_code: 980 });
    assert.ok(!offered.includes("Transfers & withdrawals"), "answering «Transfers» to «what was this transfer for» fills nothing");
    assert.ok(offered.includes("Groceries"));
    assert.deepEqual(r, { category_id: null, p: 0.95 });
  } finally { s.restore(); }
});

test("transfers: a category answer comes back as its real id", async () => {
  const s = stub(() => ({ real: choice("Utilities & connectivity", 0.9) }));
  try {
    const r = await judgeRealCategory(env(), { merchant: "Анна К.", comment: "комуналка", mcc: 4829, amount: -99300, currency_code: 980 });
    assert.equal(r?.category_id, 7);
  } finally { s.restore(); }
});

// ─── §CSV-AI columns ────────────────────────────────────────────────────────────────────────────

const ROWS = [
  ["Kontoauszug Muster Bank AG"],
  ["Buchungstag", "Verwendungszweck", "Betrag", "Waehrung"],
  ["03.06.2026", "REWE MARKT KOELN", "-42,17", "EUR"],
  ["05.06.2026", "SPOTIFY AB", "-10,99", "EUR"],
];

test("csv: the header round decides the options of the column round", async () => {
  const s = stub((q) => {
    if (q.header) return { header: choice(Object.keys(q.header.criteria ?? {})[1]) };
    const pick = (f: string, col: string) => [f, choice(Object.keys(q[f].criteria ?? {}).find((k) => k.startsWith(col))!)];
    return Object.fromEntries([
      pick("date", "col 0"), pick("description", "col 1"), pick("amount", "col 2"), pick("currency", "col 3"),
      ["comment", choice("none of these columns")], ["mcc", choice("none of these columns")],
    ]);
  });
  try {
    const m = await judgeColumns(env(), ROWS, 4);
    assert.deepEqual(m, { header_row: 1, date: 0, amount: 2, description: 1, currency: 3, comment: null, mcc: null });
    assert.deepEqual(s.asked[0], ["header"]);
    assert.equal(s.asked.length, 2);
  } finally { s.restore(); }
});

test("csv: an unsure column is left for the person, not guessed", async () => {
  const s = stub((q) => {
    if (q.header) return { header: choice(Object.keys(q.header.criteria ?? {})[1]) };
    return Object.fromEntries(Object.keys(q).map((f) => [f, choice(Object.keys(q[f].criteria ?? {})[0], 0.4)]));
  });
  try {
    const m = await judgeColumns(env(), ROWS, 4);
    assert.equal(m?.date, null);
    assert.equal(m?.amount, null);
  } finally { s.restore(); }
});
