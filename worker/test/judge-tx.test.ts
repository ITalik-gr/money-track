/**
 * docs/JEV.md phases 1–2 — the machinery around the Jev call.
 *
 * Nothing here reaches TypeSafe: `fetch` is stubbed. Whether Jev is RIGHT is `npm run eval
 * -- --judge jev`'s job. What is pinned here is what no eval run would notice going wrong:
 *
 *  · who may reach a deployment-wide key (owner only, never a demo);
 *  · that every failure means «use the Haiku ladder» rather than a row filed on half a verdict;
 *  · how two questions that cannot see each other are reconciled;
 *  · that a judgment is priced on its own basis, not as a Haiku call;
 *  · the cascade line and the leaf line — the two measured numbers (§7.2) the result hangs on;
 *  · that a brand name can only ever be a piece of what the bank sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { judgeTransaction, brandCandidates, ROOT_CASCADE_AT, LEAF_AT } from "../lib/ai/judge-tx.ts";
import { categoryGuide } from "../lib/ai/judge-guide.ts";
import { callCostUsd } from "../lib/ai/cost.ts";
import { JEV_MODEL } from "../lib/ai/models.ts";
import type { Env } from "../env.ts";

const TX = { merchant: "UKLON", comment: null, mcc: null, amount: -15400, currency_code: 980 };

function env(over: Partial<Env> = {}): Env {
  return { DB: migratedDb(), USER_ID: "u1", IS_OWNER: true, JEV_API_KEY: "k", ENRICH_JUDGE: "jev", ...over } as unknown as Env;
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

test("the flag off, a non-owner or a demo never reaches TypeSafe", async () => {
  const s = stub({ Transport: 1 }, { expense: 1 }, 0);
  try {
    assert.equal(await judgeTransaction(env({ ENRICH_JUDGE: undefined }), TX), null);
    // A deployment-wide key applied to every user is the defect `userCredentials` was fixed for.
    assert.equal(await judgeTransaction(env({ IS_OWNER: false }), TX), null);
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

test("a weak «transfer» does not override a confident category", async () => {
  // The first eval run's flake: UKLON at Transport 0.99 beside `kind` transfer at ~0.5.
  const s = stub({ Transport: 0.99, "Transfers & withdrawals": 0.01 }, { transfer: 0.5, expense: 0.45, income: 0.05 }, 0.2);
  try {
    const r = await judgeTransaction(env(), TX);
    assert.equal(r?.result.category_id, 3);
    assert.equal(r?.result.kind, "expense");
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

test("an incoming row is offered income roots only (plus the transfer bucket)", async () => {
  let offered: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    offered = Object.keys(JSON.parse(String(init?.body)).questions.root_category.criteria);
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  try {
    await judgeTransaction(env(), { ...TX, amount: 500000, merchant: "UPWORK" });
    assert.ok(offered.includes("Freelance"));
    assert.ok(offered.includes("Transfers & withdrawals"));
    assert.ok(!offered.includes("Groceries"));
  } finally { globalThis.fetch = real; }
});

test("a judgment is priced input-only, not as a Haiku call", () => {
  const usd = callCostUsd(JEV_MODEL, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(Number(usd.toFixed(3)), 0.042);
});

test("an unsure root is handed to the Haiku ladder — the cascade", async () => {
  // docs/JEV.md §7.2: every miss on the eval sat below this line. «Other» at 0.43 is Jev not
  // knowing the brand, and a model that does is one fallback away.
  const s = stub({ Other: ROOT_CASCADE_AT - 0.05, Electronics: 1 - (ROOT_CASCADE_AT - 0.05) }, { expense: 1 }, 0);
  try {
    assert.equal(await judgeTransaction(env(), { ...TX, merchant: "CITRUS.UA" }), null);
    assert.equal(s.calls, 1, "no leaf round is paid for a row that is handed on");
  } finally { s.restore(); }
});

test("an unsure «transfer» is NOT cascaded: the transfer bucket asks its own question later", async () => {
  const s = stub({ "Transfers & withdrawals": 0.55, Other: 0.45 }, { transfer: 0.9, expense: 0.1 }, 0);
  try {
    assert.equal((await judgeTransaction(env(), { ...TX, merchant: "На картку" }))?.result.category_id, 13);
  } finally { s.restore(); }
});

test("the leaf is filed only above its line; below it the root is", async () => {
  let s = stub({ Transport: 1 }, { expense: 1 }, 0, { leaf: { Taxi: LEAF_AT + 0.1, Fuel: 1 - (LEAF_AT + 0.1) } });
  try {
    assert.equal((await judgeTransaction(env(), TX))?.result.category_id, 35);
    assert.deepEqual(s.asked[1], ["leaf"], "the second request asks the leaf alone");
  } finally { s.restore(); }
  s = stub({ Transport: 1 }, { expense: 1 }, 0, { leaf: { Taxi: LEAF_AT - 0.1, Fuel: 1 - (LEAF_AT - 0.1) } });
  try {
    assert.equal((await judgeTransaction(env(), TX))?.result.category_id, 3);
  } finally { s.restore(); }
});

test("a root with no children costs no second request", async () => {
  const s = stub({ Electronics: 1 }, { expense: 1 }, 0);
  try {
    assert.equal((await judgeTransaction(env(), { ...TX, merchant: "ROZETKA" }))?.result.category_id, 9);
    assert.equal(s.calls, 1);
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

test("every seed category Jev can be offered has a text in the shared guide", () => {
  // The guide is prose for a model, parsed loosely; this is what keeps a reword of `CACHE_GUIDE`
  // from silently leaving a category described by its name alone (docs/JEV.md §7.2).
  const seed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47];
  const missing = seed.filter((id) => !categoryGuide(id));
  assert.deepEqual(missing, []);
  assert.ok(categoryGuide(30)?.covers.includes("Сільпо"), "a leaf keeps its own brand list");
});

test("phase 3: importance and business come back as PROPOSALS, in the canon's own levels", async () => {
  const s = stub({ Transport: 1 }, { expense: 1 }, 0, { business: 0.93, importance: { 0: 0.7, 1: 0.2, 2: 0.1 } });
  try {
    const r = await judgeTransaction(env(), TX);
    assert.equal(r?.result.importance, "essential");
    assert.equal(r?.result.business, 0.93, "the raw probability, so the screen's line can move");
    assert.ok(s.asked[0].includes("importance") && s.asked[0].includes("business"));
  } finally { s.restore(); }
});

test("phase 3: an incoming payment is not asked «how necessary», and own money gets no proposal", async () => {
  let s = stub({ Freelance: 1 }, { income: 1 }, 0);
  try {
    const r = await judgeTransaction(env(), { ...TX, amount: 500000, merchant: "UPWORK" });
    assert.ok(!s.asked[0].includes("importance"));
    assert.equal(r?.result.importance, undefined);
  } finally { s.restore(); }
  s = stub({ "Transfers & withdrawals": 0.9, Other: 0.1 }, { transfer: 0.95, expense: 0.05 }, 0, { business: 0.9 });
  try {
    const r = await judgeTransaction(env(), { ...TX, merchant: "На картку" });
    assert.equal(r?.result.business, undefined);
    assert.equal(r?.result.importance, undefined);
  } finally { s.restore(); }
});
