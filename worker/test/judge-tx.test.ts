/**
 * Jev in enrich with `fetch` stubbed (accuracy is `npm run eval`'s job): owner-only key, every failure
 * falls back to the Haiku ladder, the cascade and leaf lines, and the brand comes from the bank text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, migratedDirectoryDb } from "./harness.ts";
import { judgeTransaction, brandCandidates } from "../lib/ai/judge-tx.ts";
import type { Env } from "../env.ts";

const TX = { merchant: "UKLON", comment: null, mcc: null, amount: -15400, currency_code: 980 };

function env(over: Partial<Env> = {}): Env {
  return { DB: migratedDb(), USER_ID: "u1", IS_OWNER: true, JEV_API_KEY: "k", AI_JUDGE: "jev", ...over } as unknown as Env;
}

type Probs = Record<string, number>;
const top = (p: Probs) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];

const choice = (p: Probs) => ({ type: "choice", choice: top(p), probabilities: p, confidence: 0.9 });

/**
 * Stub TypeSafe with fixed distributions, answering ONLY the questions each request asks — the
 * leaf round is a second request with a different question set. Records every request's questions.
 */
function stub(
  root: Probs, kind: Probs, recurring: number,
  opts: { status?: number; leaf?: Probs; brand?: string; business?: number; importance?: Probs } = {},
): { calls: number; asked: string[][]; restore: () => void } {
  const real = globalThis.fetch;
  const s = { calls: 0, asked: [] as string[][], restore: () => { globalThis.fetch = real; } };
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    s.calls++;
    const q = JSON.parse(String(init?.body)).questions as Record<string, { criteria: Record<string, unknown> }>;
    s.asked.push(Object.keys(q));
    const all: Record<string, unknown> = {
      root_category: choice(root),
      kind: choice(kind),
      recurring: { type: "noul", noul: recurring },
      brand: choice({ [opts.brand ?? "none of these"]: 1 }),
      business: { type: "noul", noul: opts.business ?? 0.1 },
      importance: { type: "score", score: 1, confidence: 0.9, probabilities: opts.importance ?? { 0: 0, 1: 1, 2: 0 } },
      leaf: choice(opts.leaf ?? { [Object.keys(q.leaf?.criteria ?? { x: 1 }).at(-1)!]: 1 }),
    };
    const answers = Object.fromEntries(Object.keys(q).map((k) => [k, all[k]]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1500, output_tokens: 250 } }), { status: opts.status ?? 200 });
  }) as typeof fetch;
  return s;
}

test("the flag off, no key or a demo never reaches TypeSafe", async () => {
  const s = stub({ Transport: 1 }, { expense: 1 }, 0);
  try {
    assert.equal(await judgeTransaction(env({ AI_JUDGE: undefined }), TX), null);
    // demo.ts caps spend in Anthropic dollars and knows nothing about a second provider.
    assert.equal(await judgeTransaction(env({ USER_ID: "demo:abc" }), TX), null);
    assert.equal(await judgeTransaction(env({ JEV_API_KEY: "" }), TX), null);
    assert.equal(s.calls, 0);
  } finally { s.restore(); }
});

test("a failed request means the Haiku ladder, not a half-filed row", async () => {
  const s = stub({ Transport: 1 }, { expense: 1 }, 0, { status: 429 });
  try {
    assert.equal(await judgeTransaction(env(), TX), null);
    assert.equal(s.calls, 1);
  } finally { s.restore(); }
});

test("the root is filed as a real category id, and recurring crosses its line", async () => {
  // The leaf round answers «none of the specific ones» (the stub's default), so the ROOT is filed.
  const s = stub({ Transport: 0.99, "Transfers & withdrawals": 0.01 }, { expense: 0.9, transfer: 0.1 }, 0.7);
  try {
    const r = await judgeTransaction(env(), TX);
    assert.equal(r?.result.category_id, 3);
    assert.equal(r?.result.kind, "expense");
    assert.equal(r?.result.recurring, true);
    // Empty on purpose: `applyEnrichment` then keeps the name the deterministic ladder gave.
    assert.equal(r?.result.clean_name, "");
  } finally { s.restore(); }
});

test("a confident «transfer» moves the row to the transfer bucket and is never a subscription", async () => {
  const s = stub({ Groceries: 0.6, "Transfers & withdrawals": 0.4 }, { transfer: 0.95, expense: 0.05 }, 0.8);
  try {
    const r = await judgeTransaction(env(), { ...TX, merchant: "На картку" });
    assert.equal(r?.result.category_id, 13);
    assert.equal(r?.result.kind, "transfer");
    assert.equal(r?.result.recurring, false);
  } finally { s.restore(); }
});

test("the brand is a piece of what the bank sent, never a spelling Jev made up", async () => {
  assert.ok(brandCandidates("CITRUS.UA").includes("CITRUS"));
  // «911» is part of the brand here; «N254» is a code and never offered.
  assert.ok(brandCandidates("APTEKA 911 N254").includes("APTEKA 911"));
  assert.ok(!brandCandidates("APTEKA 911 N254").some((c) => c.includes("N254")));
  assert.ok(!brandCandidates("ATB 1234 KYIV").includes("1234"), "a number never stands alone");
  assert.ok(brandCandidates("1PASSWORD").includes("1PASSWORD"));
  const s = stub({ Electronics: 1 }, { expense: 1 }, 0, { brand: "CITRUS" });
  try {
    assert.equal((await judgeTransaction(env(), { ...TX, merchant: "CITRUS.UA" }))?.result.clean_name, "Citrus");
  } finally { s.restore(); }
});

test("phase 3: importance and business come back as PROPOSALS, in the canon's own levels", async () => {
  const s = stub({ Transport: 1 }, { expense: 1 }, 0, { business: 0.93, importance: { 0: 0.7, 1: 0.2, 2: 0.1 } });
  try {
    const r = await judgeTransaction(env(), TX);
    assert.equal(r?.result.importance, "essential");
    assert.equal(r?.result.business, 0.93, "the raw probability, so the screen's line can move");
    assert.ok(s.asked[0].includes("business"));
    // §7.4: importance is asked where the root is KNOWN (86% → 97% on the eval).
    assert.ok(!s.asked[0].includes("importance") && s.asked[1].includes("importance"));
  } finally { s.restore(); }
});

test("§JEV-SHARED: an account without its own key judges on the owner's, and every call is counted", async () => {
  const s = stub({ Transport: 1 }, { expense: 1 }, 0);
  const dir = migratedDirectoryDb();
  try {
    const shared = env({ IS_OWNER: false, USER_ID: "friend", JEV_SHARED: true, DIRECTORY: dir as unknown as D1Database });
    await judgeTransaction(shared, TX);
    await judgeTransaction(shared, TX);
    assert.ok(s.calls >= 2, "a non-owner reaches TypeSafe now");
    const row = dir.raw.prepare("SELECT calls, input_tokens FROM jev_usage WHERE user_id = 'friend'").get() as { calls: number; input_tokens: number };
    // Every request that went out on the lent key is in the counter — no more, no less.
    assert.deepEqual({ ...row }, { calls: s.calls, input_tokens: s.calls * 1500 });
    // Their OWN key (or the owner himself) is not a loan and is not counted.
    await judgeTransaction(env({ IS_OWNER: false, USER_ID: "own", JEV_SHARED: false, DIRECTORY: dir as unknown as D1Database }), TX);
    assert.equal(dir.raw.prepare("SELECT COUNT(*) AS n FROM jev_usage WHERE user_id = 'own'").get()!.n as number, 0);
  } finally { s.restore(); }
});
