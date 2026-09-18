#!/usr/bin/env node
/**
 * §AI-EVAL — the measuring stick for everything the model decides.
 *
 * WHY THIS EXISTS. Sixty-nine test files pin every number this app computes, and not one of them
 * asks whether the MODEL was right. So every prompt edit, every model swap and every change to
 * §ENRICH-GATE was judged by reading a few rows and forming an impression. That is not a green
 * bar, it is a mood — and it is the one place in the project where correctness rested on memory,
 * which the working rules («Перевірка > інструкція») say is the moment to build a check.
 *
 * WHAT IT RUNS. The production ladder, end to end, on a real migrated schema:
 *
 *     categorize()  →  enrichVerdict()  →  enrichOne()  →  read the row back
 *
 * Not a copy of the prompt, not a mock of the gate. A harness that re-declared either would only
 * prove the copy agrees with itself — the same reason `golden.test.ts` calls the real handlers.
 * The only thing stubbed is the clock; the network is real, which is why this is NOT part of
 * `npm run check`: it costs money and it is non-deterministic. It is a tool you run deliberately,
 * before and after a change, and compare.
 *
 * WHAT IT REPORTS, and why each number is there:
 *   • root accuracy      — the honest score: sub-categories roll up (§Інваріанти), so landing on
 *                          «Кава» when «Кафе і ресторани» was expected is RIGHT, not a near-miss.
 *   • exact accuracy     — the finer read, reported beside it rather than instead of it.
 *   • recurring accuracy — scored apart, because it is the one verdict only enrichment can reach
 *                          and a wrong `true` plants a subscription the user must dismiss.
 *   • gate accuracy      — did §ENRICH-GATE ask, skip or carry as intended.
 *   • ask rate + cost    — the two halves of one trade-off. A gate that asks too much is money; a
 *                          gate that asks too little is errors. Reporting either alone lets a
 *                          "cheaper" change look like an improvement while quietly going blind.
 *
 * Usage:
 *   node scripts/eval-ai.mjs                  # run, print the report, diff against the baseline
 *   node scripts/eval-ai.mjs --group subs     # one slice while iterating on one prompt
 *   node scripts/eval-ai.mjs --case netflix   # one case
 *   node scripts/eval-ai.mjs --dry            # gate only: no network, no cost, still scores the gate
 *   node scripts/eval-ai.mjs --record         # write the baseline (deliberate, reviewed changes only)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { migratedDb } from "../worker/test/harness.ts";
import { categorize } from "../worker/lib/finance/categorize.ts";
import { gateRow, enrichVerdict, applyCarry } from "../worker/lib/ai/enrich-gate.ts";
import { enrichOne } from "../worker/lib/ai/enrich.ts";
import { callCostUsd } from "../worker/lib/ai/cost.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "worker", "test", "__eval__");
const BASELINE = join(EVAL_DIR, "baseline.json");

// ─── arguments ──────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ONLY_GROUP = value("group", null);
const ONLY_CASE = value("case", null);
const LIMIT = Number(value("limit", 0)) || 0;
const CONCURRENCY = Number(value("concurrency", 4)) || 4;
const DRY = flag("dry");
const RECORD = flag("record");

// ─── the key ────────────────────────────────────────────────────────────────────────────────────
/**
 * Read `.dev.vars` the way `wrangler dev` does. The key never reaches the repo and never reaches
 * an argument (a shell history is not a secret store), which is the same rule the deploy docs
 * state for every other secret.
 */
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const f = join(HERE, "..", ".dev.vars");
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// ─── cost meter ─────────────────────────────────────────────────────────────────────────────────
/**
 * Count tokens at the TRANSPORT, not at the call sites.
 *
 * `applyEnrichment` swallows the usage it gets back (it only logs it), and §F2 step 2 can fire a
 * second call from inside `enrichOne`. Wrapping `fetch` counts whatever actually left the process
 * — including calls a future refactor adds — instead of counting what this script remembered to
 * ask about. The same reason the SQL linter reads the query text rather than the call site.
 */
const meter = { calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, usd: 0, byModel: {}, uncached: [] };
function meterFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const res = await real(...args);
    try {
      const url = String(args[0]?.url ?? args[0]);
      if (!url.includes("anthropic.com")) return res;
      const clone = res.clone();
      const body = await clone.json();
      const u = body?.usage;
      if (!u) return res;
      const model = body?.model ?? "unknown";
      const usage = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      };
      const usd = callCostUsd(model, usage);
      meter.calls++;
      meter.in += usage.input_tokens;
      meter.out += usage.output_tokens;
      meter.cache_read += usage.cache_read_input_tokens;
      meter.cache_write += usage.cache_creation_input_tokens;
      meter.usd += usd;
      meter.byModel[model] = (meter.byModel[model] ?? 0) + 1;
      // A call that neither wrote nor read the cache, while carrying a prefix big enough to be
      // worth caching. See the cache report below for why this is worth a line of its own.
      if (!usage.cache_read_input_tokens && !usage.cache_creation_input_tokens && usage.input_tokens > 2000) {
        meter.uncached.push({ model, in: usage.input_tokens });
      }
    } catch { /* the meter never breaks the run it is measuring */ }
    return res;
  };
}

// ─── one case ───────────────────────────────────────────────────────────────────────────────────
const NOW = Math.floor(Date.parse("2026-05-14T09:00:00.000Z") / 1000);

function insertTx(db, row) {
  const cols = Object.keys(row);
  db.raw.prepare(`INSERT INTO transactions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

/**
 * Run the whole ladder on one case, in its own database.
 *
 * A fresh schema per case rather than one shared database with deletes between: `previousVerdict`
 * and `consensusCategory` both read every other row in the table, so one case's context would
 * silently become the next case's history — and the failure would look like a model regression.
 */
async function runCase(c, key) {
  const db = migratedDb();
  const env = {
    DB: db,
    USER_ID: "eval",
    IS_OWNER: "1",
    ANTHROPIC_API_KEY: DRY ? "" : key,
  };
  db.raw.prepare("INSERT INTO accounts (id, type, title, currency_code, balance) VALUES ('acc', 'black', 'Eval', 980, 0)").run();

  for (const [i, ctx] of (c.context ?? []).entries()) {
    insertTx(db, {
      id: `ctx${i}`, account_id: "acc", source: "mono", time: NOW - 86400 * (i + 1),
      amount: ctx.amount, currency_code: ctx.currency ?? 980, mcc: ctx.mcc ?? null,
      category_id: ctx.category ?? null, merchant: ctx.merchant ?? ctx.desc,
      raw_json: JSON.stringify({ description: ctx.desc }),
      ai_enriched: ctx.ai_enriched ?? 0, ai_recurring: ctx.ai_recurring ?? null,
    });
  }

  // Step 1 — the deterministic ladder that every ingest path runs BEFORE the gate sees the row.
  // Skipping it would hand the gate a category-less row every time, and «no category» is its
  // single strongest reason to ask: the eval would then measure a gate that never fires.
  const det = await categorize(db, {
    mcc: c.mcc ?? null, description: c.desc, comment: c.comment ?? null,
    amount: c.amount, currency_code: c.currency ?? 980,
  });

  const id = "subject";
  insertTx(db, {
    id, account_id: "acc", source: "mono", time: NOW,
    amount: c.amount, currency_code: c.currency ?? 980, mcc: c.mcc ?? null,
    category_id: det.category_id, merchant: det.display_name ?? c.desc,
    comment: c.comment ?? null, user_note: c.note ?? null,
    raw_json: JSON.stringify({ description: c.desc }),
    is_transfer: c.is_transfer ?? (det.is_transfer ? 1 : 0),
    ai_enriched: c.ai_enriched ?? 0,
  });

  // Step 2 — the gate.
  const row = await gateRow(env, id);
  const verdict = await enrichVerdict(env, row);

  // Step 3 — what the gate decided, actually carried out.
  let error = null;
  if (verdict.verdict === "carry") {
    await applyCarry(env, id, verdict.recurring);
  } else if (verdict.verdict === "ask" && !DRY) {
    try { await enrichOne(env, id); } catch (e) { error = e?.message ?? String(e); }
  }

  const after = db.raw.prepare(
    `SELECT t.category_id, t.is_transfer, t.ai_recurring, t.merchant,
            COALESCE(c.parent_id, t.category_id) AS root
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
  ).get(id);

  return { id: c.id, group: c.group, verdict: verdict.verdict, why: verdict.why ?? null, after, error };
}

// ─── scoring ────────────────────────────────────────────────────────────────────────────────────
/**
 * A case is scored only on what it declares. An expectation nobody wrote is not a silent pass and
 * not a silent fail — it is simply not part of that case, and the denominators say so.
 */
function score(c, got) {
  const checks = [];
  const e = c.expect ?? {};
  if (e.gate) checks.push({ kind: "gate", want: e.gate, got: got.verdict });
  if (e.root != null) checks.push({ kind: "root", want: e.root, got: got.after?.root ?? null });
  if (e.category != null) checks.push({ kind: "exact", want: e.category, got: got.after?.category_id ?? null });
  if (e.recurring != null) checks.push({ kind: "recurring", want: e.recurring, got: got.after?.ai_recurring ?? null });
  if (e.transfer != null) checks.push({ kind: "transfer", want: e.transfer ? 1 : 0, got: got.after?.is_transfer ?? 0 });
  for (const ch of checks) ch.ok = ch.want === ch.got;
  return checks;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// ─── main ───────────────────────────────────────────────────────────────────────────────────────
const { cases } = JSON.parse(readFileSync(join(EVAL_DIR, "cases.json"), "utf8"));
let selected = cases;
if (ONLY_GROUP) selected = selected.filter((c) => c.group === ONLY_GROUP);
if (ONLY_CASE) selected = selected.filter((c) => c.id === ONLY_CASE);
if (LIMIT) selected = selected.slice(0, LIMIT);

const key = apiKey();
if (!key && !DRY) {
  console.error("No ANTHROPIC_API_KEY (env or .dev.vars). Run with --dry to score the gate alone.");
  process.exit(1);
}
if (!DRY) meterFetch();

const t0 = Date.now();
const results = await pool(selected, CONCURRENCY, async (c) => {
  const got = await runCase(c, key);
  return { c, got, checks: score(c, got) };
});
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

// ─── report ─────────────────────────────────────────────────────────────────────────────────────
const tally = {};
const add = (kind, ok) => {
  tally[kind] ??= { ok: 0, n: 0 };
  tally[kind].n++;
  if (ok) tally[kind].ok++;
};

const failures = [];
const confusion = [];
for (const r of results) {
  for (const ch of r.checks) {
    add(ch.kind, ch.ok);
    if (!ch.ok) {
      failures.push({ id: r.c.id, group: r.c.group, kind: ch.kind, want: ch.want, got: ch.got, why: r.c.why });
      if (ch.kind === "root") confusion.push(`${ch.want}→${ch.got}`);
    }
  }
  if (r.got.error) failures.push({ id: r.c.id, group: r.c.group, kind: "error", want: "-", got: r.got.error, why: r.c.why });
}

const pct = (t) => (t.n ? `${((t.ok / t.n) * 100).toFixed(1)}% (${t.ok}/${t.n})` : "—");
const asked = results.filter((r) => r.got.verdict === "ask").length;

console.log(`\n=== AI eval — ${results.length} cases in ${seconds}s ===\n`);
for (const kind of ["gate", "root", "exact", "recurring", "transfer"]) {
  if (tally[kind]) console.log(`  ${kind.padEnd(10)} ${pct(tally[kind])}`);
}
console.log(`\n  gate: asked ${asked}/${results.length} (${((asked / results.length) * 100).toFixed(0)}%)` +
  `, carried ${results.filter((r) => r.got.verdict === "carry").length}` +
  `, skipped ${results.filter((r) => r.got.verdict === "skip").length}`);

if (!DRY) {
  console.log(`  cost: $${meter.usd.toFixed(4)} over ${meter.calls} calls` +
    ` (in ${meter.in}, out ${meter.out}, cache read ${meter.cache_read}, cache write ${meter.cache_write})`);
  console.log(`  per 1000 ingested rows at this ask rate: ~$${((meter.usd / results.length) * 1000).toFixed(2)}`);
  for (const [m, n] of Object.entries(meter.byModel)) console.log(`    ${m}: ${n} calls`);

  /**
   * THE PROMPT CACHE, MEASURED — and the reason this block exists at all.
   *
   * `buildSystemPrefix(…, cached = true)` attaches `cache_control` on the bulk-enrich path and
   * pads the prefix with `CACHE_GUIDE` specifically to clear Haiku's 4 096-token minimum. When the
   * prefix lands UNDER that line the API does not error and does not warn: it simply does not
   * cache, every call pays full input price, and nothing anywhere says so. The first run of this
   * harness found exactly that — 46 Haiku calls at ~4 067 tokens each, twenty-nine tokens short.
   *
   * So the number is printed on every run. A silent cost regression is the kind a person only
   * finds in a monthly bill, and by then it has been true for a month.
   */
  if (meter.uncached.length) {
    const worst = Math.max(...meter.uncached.map((u) => u.in));
    console.log(`\n  ⚠️  prompt cache: ${meter.uncached.length} of ${meter.calls} calls neither read nor wrote it` +
      ` (largest prefix ${worst} tokens).`);
    if (worst < 4096) {
      console.log(`      Haiku will not cache a prefix under 4096 tokens — this one is ${4096 - worst} short,` +
        ` so the padding in CACHE_GUIDE is not doing its job.`);
    }
  } else if (meter.cache_read) {
    console.log(`\n  prompt cache: reading (${meter.cache_read} tokens read, ${meter.cache_write} written)`);
  }
}

if (failures.length) {
  console.log(`\n--- ${failures.length} miss(es) ---`);
  for (const f of failures) {
    console.log(`  [${f.group}] ${f.id} — ${f.kind}: wanted ${f.want}, got ${f.got}`);
    if (f.why) console.log(`      pins: ${f.why}`);
  }
  if (confusion.length) console.log(`\n  category confusion (want→got): ${confusion.join(", ")}`);
}

// ─── baseline ───────────────────────────────────────────────────────────────────────────────────
/**
 * Same contract as `__golden__`: a diff means the model behaves differently, and telling a
 * regression from an intended change is the entire job. Never re-record to make a red run green.
 */
const current = Object.fromEntries(results.map((r) => [r.c.id, {
  verdict: r.got.verdict,
  root: r.got.after?.root ?? null,
  recurring: r.got.after?.ai_recurring ?? null,
  pass: r.checks.every((ch) => ch.ok),
}]));

// The full run, on disk. A run costs real money, so losing its detail to a scrolled-off terminal
// would mean paying twice to answer the same question.
writeFileSync(join(EVAL_DIR, "last-run.json"), `${JSON.stringify({
  at: new Date().toISOString(), dry: DRY, seconds: Number(seconds), tally, meter,
  results: results.map((r) => ({ id: r.c.id, group: r.c.group, verdict: r.got.verdict,
    merchant: r.got.after?.merchant ?? null, root: r.got.after?.root ?? null,
    category: r.got.after?.category_id ?? null, recurring: r.got.after?.ai_recurring ?? null,
    checks: r.checks, error: r.got.error })),
}, null, 2)}\n`);

if (RECORD) {
  writeFileSync(BASELINE, `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), cases: current }, null, 2)}\n`);
  console.log(`\nBaseline written: ${BASELINE}`);
} else if (existsSync(BASELINE)) {
  const prev = JSON.parse(readFileSync(BASELINE, "utf8")).cases ?? {};
  const moved = [];
  for (const [id, now] of Object.entries(current)) {
    const was = prev[id];
    if (!was) { moved.push(`  + ${id} — new, not in the baseline`); continue; }
    if (was.pass && !now.pass) moved.push(`  ↓ ${id} — passed in the baseline, fails now`);
    if (!was.pass && now.pass) moved.push(`  ↑ ${id} — failed in the baseline, passes now`);
    if (was.pass && now.pass && was.root !== now.root) moved.push(`  ~ ${id} — same verdict, different category (${was.root} → ${now.root})`);
  }
  console.log(moved.length ? `\n--- against the baseline ---\n${moved.join("\n")}` : "\n--- against the baseline: no movement ---");
} else {
  console.log("\nNo baseline yet. Record one with --record once this run looks right.");
}

// A miss is not a process failure: the model is allowed to be wrong, and a non-zero exit would
// make this unusable from a shell that stops on error. The report is the output.
console.log("");
