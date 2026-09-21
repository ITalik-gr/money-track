#!/usr/bin/env node
/**
 * docs/JEV.md phase 4 — the measuring stick for the judgments OUTSIDE enrich.
 *
 * `eval-ai.mjs` runs the enrich ladder end to end. The four phase-4 sites are different shapes —
 * a merchant verdict, a real category, a column index, a relevance call — so they get their own,
 * smaller harness over `worker/test/__eval__/sites.json`. Same contract, though: it calls the REAL
 * production functions (`judgeSubs`, `judgeRealCategory`, `judgeColumns`, `judgeRelevant`), never
 * copies of their questions, and a case is scored only on what it declares.
 *
 * Claude is the comparison, not the default: `--claude` also runs the Claude path of the three
 * sites that had one (§SUB-REVIEW, §F2, §CSV-AI), once. The search rerank has no Claude path — its
 * baseline is the cosine floor, which needs the live index and is not measured here.
 *
 * Usage:
 *   node scripts/eval-sites.mjs                 # Jev only, costs a fraction of a cent
 *   node scripts/eval-sites.mjs --claude        # + the Claude path of subs / transfers / csv
 *   node scripts/eval-sites.mjs --site subs     # one site
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { migratedDb } from "../worker/test/harness.ts";
import { judgeSubs, SUB_AT, NOT_AT } from "../worker/lib/ai/judge-subs.ts";
import { judgeRealCategory } from "../worker/lib/ai/judge-spend.ts";
import { judgeColumns } from "../worker/lib/ai/judge-columns.ts";
import { judgeRelevant, RELEVANT_AT } from "../worker/lib/ai/judge-search.ts";
import { ROOT_CASCADE_AT } from "../worker/lib/ai/judge-tx.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "worker", "test", "__eval__");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const ONLY = value("site");
const CLAUDE = flag("claude");

function devVar(name) {
  if (process.env[name]) return process.env[name];
  const f = join(HERE, "..", ".dev.vars");
  if (!existsSync(f)) return null;
  const m = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(readFileSync(f, "utf8"));
  return m ? m[1].trim() : null;
}

/** A fresh schema per env: the category list the judges read is the real seed. */
function env(judge) {
  const db = migratedDb();
  return {
    DB: db, USER_ID: "eval", IS_OWNER: "1",
    AI_JUDGE: judge, JEV_API_KEY: judge === "jev" ? devVar("JEV_API_KEY") : "",
    ANTHROPIC_API_KEY: CLAUDE ? devVar("ANTHROPIC_API_KEY") : "",
  };
}

// Cost, counted at the transport for the same reason as in eval-ai.mjs.
const cost = { jev_in: 0, claude_calls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const res = await realFetch(...args);
  try {
    const url = String(args[0]?.url ?? args[0]);
    if (url.includes("typesafe.ai")) cost.jev_in += (await res.clone().json())?.usage?.input_tokens ?? 0;
    if (url.includes("anthropic.com")) cost.claude_calls++;
  } catch { /* the meter never breaks the run */ }
  return res;
};

const sites = JSON.parse(readFileSync(join(EVAL_DIR, "sites.json"), "utf8"));
const report = {};
const misses = [];
const pct = (ok, n) => (n ? `${((ok / n) * 100).toFixed(1)}% (${ok}/${n})` : "—");

// ─── §SUB-REVIEW ────────────────────────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "subs") {
  const rows = sites.subs.map((s) => ({
    merchant: s.merchant, amount: s.amount * 100, currency_code: 980, n: s.charges, months: s.months,
    avg_interval_days: s.every_days, near_miss: s.near_miss ?? null,
  }));
  const score = (name, verdicts) => {
    let ok = 0, unsure = 0, wrong = 0;
    for (const s of sites.subs) {
      const v = verdicts.find((x) => x.merchant?.toLowerCase() === s.merchant.toLowerCase())?.verdict ?? "unsure";
      if (v === s.expect) ok++;
      else if (v === "unsure") unsure++;
      else { wrong++; misses.push(`[subs/${name}] ${s.merchant}: wanted ${s.expect}, got ${v}`); }
    }
    // Two numbers, because they cost different things: `unsure` is asked again next month, a WRONG
    // verdict is a subscription hidden under «AI відхилив» or a shop proposed as a bill.
    report[`subs · ${name}`] = `right ${pct(ok, sites.subs.length)} · unsure ${unsure} · WRONG ${wrong}`;
  };
  const jv = await judgeSubs(env("jev"), rows);
  if (jv) score("jev", jv); else report["subs · jev"] = "failed";
  if (CLAUDE) {
    const { askBatch } = await import("../worker/lib/ai/subs-review.ts");
    score("claude", await askBatch(env("haiku"), rows));
  }
}

// ─── §F2 real category ──────────────────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "transfers") {
  let ok = 0, answered = 0, cOk = 0;
  for (const t of sites.transfers) {
    const input = { merchant: t.desc, comment: t.comment, mcc: t.mcc, amount: t.amount, currency_code: 980 };
    const j = await judgeRealCategory(env("jev"), input);
    // Scored as production uses it: only a confident answer is Jev's; below the line Claude answers.
    if (j && j.p >= ROOT_CASCADE_AT) {
      answered++;
      if (j.category_id === t.expect) ok++;
      else misses.push(`[transfers/jev] ${t.desc} «${t.comment ?? ""}»: wanted ${t.expect}, got ${j.category_id} @${j.p.toFixed(2)}`);
    }
    if (CLAUDE) {
      const { proposeTransferCategory } = await import("../worker/lib/ai/enrich.ts");
      const { result } = await proposeTransferCategory(env("haiku"), input);
      if ((result.real_category_id ?? null) === t.expect) cOk++;
      else misses.push(`[transfers/claude] ${t.desc}: wanted ${t.expect}, got ${result.real_category_id}`);
    }
  }
  report["transfers · jev"] = `answers ${answered}/${sites.transfers.length}, right ${pct(ok, answered)}`;
  if (CLAUDE) report["transfers · claude"] = `right ${pct(cOk, sites.transfers.length)}`;
}

// ─── §CSV-AI columns ────────────────────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "csv") {
  const FIELDS = ["header_row", "date", "amount", "description", "currency", "comment", "mcc"];
  const score = (name, c, m) => {
    // A file is right only when EVERY declared field is: one wrong column imports wrong numbers.
    const bad = FIELDS.filter((f) => f in c.expect && (m?.[f] ?? null) !== c.expect[f]);
    if (bad.length) misses.push(`[csv/${name}] ${c.name}: ${bad.map((f) => `${f} wanted ${c.expect[f]} got ${m?.[f] ?? null}`).join(", ")}`);
    return bad.length === 0;
  };
  let ok = 0, cOk = 0;
  for (const c of sites.csv) {
    const width = Math.max(...c.rows.map((r) => r.length));
    if (score("jev", c, await judgeColumns(env("jev"), c.rows, width))) ok++;
    if (CLAUDE) {
      const { mapStatementColumns } = await import("../worker/lib/ai/statement-map.ts");
      const r = await mapStatementColumns(env("haiku"), c.rows);
      if (score("claude", c, r?.mapping ?? null)) cOk++;
    }
  }
  report["csv · jev"] = `files fully right ${pct(ok, sites.csv.length)}`;
  if (CLAUDE) report["csv · claude"] = `files fully right ${pct(cOk, sites.csv.length)}`;
}

// ─── §SEARCH-VEC rerank ─────────────────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "search") {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const s of sites.search) {
    const keep = await judgeRelevant(env("jev"), s.query, [{ id: "x", text: s.tx }]);
    const shown = !!keep?.includes("x");
    if (shown && s.expect) tp++; else if (shown) fp++; else if (s.expect) fn++; else tn++;
    if (shown !== !!s.expect) misses.push(`[search/jev] «${s.query}» → ${s.tx}: wanted ${s.expect ? "shown" : "hidden"}`);
  }
  report["search · jev"] = `right ${pct(tp + tn, sites.search.length)} · shown-but-wrong ${fp} · hidden-but-right ${fn}`;
}

console.log(`\n=== Jev phase-4 sites (lines: sub ≥${SUB_AT} / not ≤${NOT_AT}, cascade ${ROOT_CASCADE_AT}, relevant ≥${RELEVANT_AT}) ===\n`);
for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`\n  cost: Jev ${cost.jev_in} input tokens ≈ $${((cost.jev_in * 0.042) / 1e6).toFixed(4)}` +
  (CLAUDE ? ` · Claude ${cost.claude_calls} calls` : " · Claude not run"));
if (misses.length) console.log(`\n--- misses ---\n${misses.map((m) => `  ${m}`).join("\n")}`);
writeFileSync(join(EVAL_DIR, "last-run.sites.json"), `${JSON.stringify({ at: new Date().toISOString(), report, misses, cost }, null, 2)}\n`);
console.log("");
