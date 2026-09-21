/**
 * docs/JEV.md phase 1 — the machinery around the Jev call.
 *
 * Nothing here reaches TypeSafe: `fetch` is stubbed. Whether Jev is RIGHT is `npm run eval
 * -- --judge jev`'s job. What is pinned here is what no eval run would notice going wrong:
 *
 *  · who may reach a deployment-wide key (owner only, never a demo);
 *  · that every failure means «use the Haiku ladder» rather than a row filed on half a verdict;
 *  · how two questions that cannot see each other are reconciled;
 *  · that a judgment is priced on its own basis, not as a Haiku call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { judgeTransaction } from "../lib/ai/judge-tx.ts";
import { callCostUsd } from "../lib/ai/cost.ts";
import { JEV_MODEL } from "../lib/ai/models.ts";
import type { Env } from "../env.ts";

const TX = { merchant: "UKLON", comment: null, mcc: null, amount: -15400, currency_code: 980 };

function env(over: Partial<Env> = {}): Env {
  return { DB: migratedDb(), USER_ID: "u1", IS_OWNER: true, JEV_API_KEY: "k", ENRICH_JUDGE: "jev", ...over } as unknown as Env;
}

type Probs = Record<string, number>;
const top = (p: Probs) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];

/** Stub TypeSafe with fixed distributions; records how many requests went out. */
function stub(root: Probs, kind: Probs, recurring: number, status = 200): { calls: number; restore: () => void } {
  const real = globalThis.fetch;
  const s = { calls: 0, restore: () => { globalThis.fetch = real; } };
  globalThis.fetch = (async () => {
    s.calls++;
    const body = {
      model: "jev-1.13.0",
      answers: {
        root_category: { type: "choice", choice: top(root), probabilities: root, confidence: 0.9 },
        kind: { type: "choice", choice: top(kind), probabilities: kind, confidence: 0.9 },
        recurring: { type: "noul", noul: recurring },
      },
      usage: { input_tokens: 1500, output_tokens: 250 },
    };
    return new Response(JSON.stringify(body), { status });
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
  const s = stub({ Transport: 1 }, { expense: 1 }, 0, 429);
  try {
    assert.equal(await judgeTransaction(env(), TX), null);
    assert.equal(s.calls, 1);
  } finally { s.restore(); }
});

test("the root is filed as a real category id, and recurring crosses its line", async () => {
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
