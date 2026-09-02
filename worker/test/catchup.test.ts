/**
 * §AI-CATCHUP — the nightly second look at operations the app failed to file.
 *
 * The scenarios are about the REFUSALS, because the happy path is the cheap half. What makes this
 * pass safe to run unattended is that it cannot fill a row someone has already decided, cannot
 * invent a category id, cannot answer "this transfer is a transfer", and leaves an undo behind for
 * everything it does write. Each of those is one test below.
 *
 * The owner's own case opens the file: MCC 6012, «Списання відсотків за серпень», sitting in bucket
 * 13 with no real category while four identical operations were already filed. The bank rewords the
 * description every month, so merchant consensus never fired — which is why the batch is handed the
 * raw description and not the cleaned-up `merchant`.
 *
 * `fetch` is stubbed rather than the module mocked, so the prompt, `callHaikuJson`, §FK-GUARD and
 * the write guard all really run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runCatchup, catchupPending } from "../lib/ai/catchup.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import type { Env } from "../env.ts";

const NOW = Math.floor(new Date("2026-09-02T06:00:00.000Z").getTime() / 1000);
const DAY = 86400;
/** Seeded ids: 13 is «Перекази і зняття», 1 «Продукти», 9 the interest/credit-ish expense bucket. */
const TRANSFERS = 13, GROCERIES = 1;

function envWithKey(db: MemDb): Env {
  return { ...testEnv(db), ANTHROPIC_API_KEY: "sk-ant-test" } as unknown as Env;
}

/** Answers every Anthropic call with one JSON body, framed the way the real API frames it. */
function stubModel(json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 1200, output_tokens: 60 },
    stop_reason: "end_turn",
    model: "claude-haiku-4-5-20251001",
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await run(); } finally { globalThis.fetch = real; }
}

interface TxSeed {
  id: string; desc: string; merchant?: string | null; comment?: string | null; ai_note?: string | null;
  mcc?: number | null; category?: number | null; real?: number | null; daysAgo?: number; amount?: number;
}

function db(seeds: TxSeed[]): MemDb {
  const d = migratedDb();
  d.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('acc1', 'black', 'Картка', 980, 100000, 0, 1, 0)`,
  ).run();
  for (const s of seeds) {
    d.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, comment,
                                 ai_note, mcc, category_id, real_category_id, hold, is_transfer, raw_json)
       VALUES (?, 'acc1', 'mono', ?, ?, 980, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    ).run(
      s.id, NOW - (s.daysAgo ?? 1) * DAY, s.amount ?? -247663,
      s.merchant ?? s.desc, s.comment ?? null, s.ai_note ?? null, s.mcc ?? null,
      s.category ?? null, s.real ?? null, JSON.stringify({ description: s.desc }),
    );
  }
  return d;
}

test("§AI-CATCHUP: the owner's case — a bucket-13 charge gets the real category it obviously has", async () => {
  // Exactly the screenshot: MCC 6012, filed as a transfer (correctly), with no answer to "what for".
  const d = db([{ id: "t1", desc: "Списання відсотків за серпень", mcc: 6012, category: TRANSFERS }]);
  const env = envWithKey(d);
  assert.equal(await catchupPending(env, NOW), 1);

  const out = await withFetch(
    stubModel({ results: [{ id: "t1", category_id: GROCERIES }] }),
    () => runCatchup(env, NOW),
  );
  assert.deepEqual(out, { looked: 1, filled: 1, unsure: 0 });

  const row = d.raw.prepare("SELECT category_id, real_category_id FROM transactions WHERE id = 't1'").get() as { category_id: number; real_category_id: number };
  // The bucket is NOT touched: the bank operation really is a transfer, and that classification was
  // right. What was missing is the second answer, and that is the only field written.
  assert.equal(row.category_id, TRANSFERS);
  assert.equal(row.real_category_id, GROCERIES);
});

test("§AI-CATCHUP: everything written leaves an undo behind (§AI-AUDIT)", async () => {
  const d = db([{ id: "t1", desc: "Списання відсотків за серпень", mcc: 6012, category: TRANSFERS }]);
  await withFetch(stubModel({ results: [{ id: "t1", category_id: GROCERIES }] }), () => runCatchup(envWithKey(d), NOW));

  const log = d.raw.prepare("SELECT field, old_value, new_value, source FROM ai_changes WHERE tx_id = 't1'").all() as { field: string; old_value: string | null; new_value: string; source: string }[];
  assert.equal(log.length, 1);
  assert.equal(log[0].field, "real_category_id");
  // NULL is the real previous value («there was no category»), not "unknown" — that is what makes
  // the journal a revert rather than a log.
  assert.equal(log[0].old_value, null);
  assert.equal(log[0].new_value, String(GROCERIES));
  assert.equal(log[0].source, "catchup");
});

test("§AI-CATCHUP: a row that already has a category is never looked at", async () => {
  // §RULES-UI, §SIMILAR, §AI-AUDIT's revert guard all say the same thing: the app does not argue
  // silently with work already done. Here that has to hold at SELECTION, before any money is spent.
  const d = db([
    { id: "done", desc: "АТБ 247.30", category: GROCERIES },
    { id: "alsodone", desc: "Зняття готівки", category: TRANSFERS, real: GROCERIES },
  ]);
  const env = envWithKey(d);
  assert.equal(await catchupPending(env, NOW), 0);

  const out = await withFetch(
    // If the pass ever did call the model, this answer would overwrite both rows.
    stubModel({ results: [{ id: "done", category_id: 2 }, { id: "alsodone", category_id: 2 }] }),
    () => runCatchup(env, NOW),
  );
  assert.deepEqual(out, { looked: 0, filled: 0, unsure: 0 });
  const rows = d.raw.prepare("SELECT id, category_id, real_category_id FROM transactions ORDER BY id").all() as { id: string; category_id: number; real_category_id: number | null }[];
  assert.equal(rows.find((r) => r.id === "done")!.category_id, GROCERIES);
  assert.equal(rows.find((r) => r.id === "alsodone")!.real_category_id, GROCERIES);
});

test("§AI-CATCHUP: 'not sure' is an answer, and it writes nothing", async () => {
  const d = db([{ id: "t1", desc: "P2P 4441 1111 2222 3333" }]);
  const out = await withFetch(
    stubModel({ results: [{ id: "t1", category_id: null }] }),
    () => runCatchup(envWithKey(d), NOW),
  );
  assert.deepEqual(out, { looked: 1, filled: 0, unsure: 1 });
  const row = d.raw.prepare("SELECT category_id FROM transactions WHERE id = 't1'").get() as { category_id: number | null };
  assert.equal(row.category_id, null);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM ai_changes").get() as { n: number }).n, 0);
});

test("§AI-CATCHUP: an id that does not exist is dropped, not written (§FK-GUARD)", async () => {
  // Categories have holes from deletions, so a plausible id lands on no row and the UPDATE dies
  // with a foreign-key error the person only ever sees as «не вдалось».
  const d = db([{ id: "t1", desc: "Якась покупка" }]);
  const out = await withFetch(
    stubModel({ results: [{ id: "t1", category_id: 9999 }] }),
    () => runCatchup(envWithKey(d), NOW),
  );
  assert.deepEqual(out, { looked: 1, filled: 0, unsure: 1 });
  assert.equal(
    (d.raw.prepare("SELECT category_id FROM transactions WHERE id = 't1'").get() as { category_id: number | null }).category_id,
    null,
  );
});

test("§AI-CATCHUP: 'this transfer is a transfer' fills nothing", async () => {
  // A true statement that answers the question with the question. Without this guard the row would
  // read as filed while still saying nothing about where the money went.
  const d = db([{ id: "t1", desc: "Переказ на картку", category: TRANSFERS }]);
  const out = await withFetch(
    stubModel({ results: [{ id: "t1", category_id: TRANSFERS }] }),
    () => runCatchup(envWithKey(d), NOW),
  );
  assert.deepEqual(out, { looked: 1, filled: 0, unsure: 1 });
  assert.equal(
    (d.raw.prepare("SELECT real_category_id FROM transactions WHERE id = 't1'").get() as { real_category_id: number | null }).real_category_id,
    null,
  );
});

test("§AI-CATCHUP: an income category is refused for a spend", async () => {
  const d = db([{ id: "t1", desc: "Невідомо що" }]);
  const salary = (migratedDb().raw.prepare("SELECT id FROM categories WHERE is_income = 1 LIMIT 1").get() as { id: number }).id;
  const out = await withFetch(
    stubModel({ results: [{ id: "t1", category_id: salary }] }),
    () => runCatchup(envWithKey(d), NOW),
  );
  assert.deepEqual(out, { looked: 1, filled: 0, unsure: 1 });
});

test("§AI-CATCHUP: an old gap is left alone", async () => {
  // Two months on screen and still empty is a decision, or at least not something a nightly pass
  // should keep re-deciding for money that is long spent.
  const d = db([{ id: "old", desc: "Щось давнє", daysAgo: 70 }]);
  assert.equal(await catchupPending(envWithKey(d), NOW), 0);
});

test("§AI-CATCHUP: a verdict about a row we never asked about is ignored", async () => {
  const d = db([{ id: "t1", desc: "Покупка" }, { id: "other", desc: "Інша", category: GROCERIES }]);
  const out = await withFetch(
    stubModel({ results: [{ id: "t1", category_id: GROCERIES }, { id: "ghost", category_id: GROCERIES }] }),
    () => runCatchup(envWithKey(d), NOW),
  );
  assert.equal(out.filled, 1);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM ai_changes").get() as { n: number }).n, 1);
});
