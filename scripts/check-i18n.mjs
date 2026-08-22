#!/usr/bin/env node
// i18n lint (part of `npm run check`).
//
// WHY THIS EXISTS: locale correctness can't be trusted to memory (PLATFORM.md §12.2, §14.2).
// Two silent failure modes, neither visible to tsc:
//   1. A hardcoded BCP-47 tag ("uk-UA"/"en-US") keeps dates/numbers in one language after the
//      user switched — a string literal, invisible to the type checker. All locale tags MUST
//      go through localeTag() in src/i18n/locale.ts (the one allowlisted file).
//   2. The en/uk dictionaries drift out of parity. tsc catches a key missing from `en`
//      (keys are `keyof typeof en`), but NOT a key present in en and missing from uk — that
//      would silently fall back to English for that string only. Parity check covers it.
//   3. A raw `new Intl.DateTimeFormat(...)` / `new Intl.NumberFormat(...)`. These were built at
//      MODULE level in 20 files, which snapshots the locale at import time: switching the
//      language re-rendered every `t()` label but left the dates Ukrainian ("next 19 серп." on
//      an English screen — reported from the live app). `dateFmt`/`numFmt` in locale.ts resolve
//      the locale per call and cache per (locale + options), so this is a ban, not a preference.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const ALLOWED_TAG_FILE = join("src", "i18n", "locale.ts"); // the single place tags may appear
const TAG = /\b(?:uk|en)-(?:UA|US)\b/;
const RAW_INTL = /new Intl\.(?:DateTimeFormat|NumberFormat)\s*\(/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const problems = [];

// 1. Hardcoded locale tags outside the allowlisted file.
for (const file of walk(SRC)) {
  if (file === ALLOWED_TAG_FILE) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (TAG.test(line)) {
      problems.push(`${file}:${i + 1}  hardcoded locale tag — use localeTag(getLocale()) instead:\n    ${line.trim()}`);
    }
    if (RAW_INTL.test(line)) {
      problems.push(`${file}:${i + 1}  raw Intl formatter — use dateFmt()/numFmt() from i18n/locale.ts (they follow a language switch):\n    ${line.trim()}`);
    }
  });
}

// 2. Dictionary parity (en is the source of truth for the key TYPE; uk must match its keys).
const en = JSON.parse(readFileSync(join(SRC, "i18n", "en.json"), "utf8"));
const uk = JSON.parse(readFileSync(join(SRC, "i18n", "uk.json"), "utf8"));
const enKeys = new Set(Object.keys(en));
const ukKeys = new Set(Object.keys(uk));
for (const k of enKeys) if (!ukKeys.has(k)) problems.push(`uk.json missing key present in en.json: "${k}"`);
for (const k of ukKeys) if (!enKeys.has(k)) problems.push(`en.json missing key present in uk.json: "${k}"`);

// 3. §BASE-CUR — no currency symbol spelled out in a UI string.
//
// Twenty-eight entries said "₴" while the server had already converted the number beside it into
// the reader's currency, which is exactly the "everything is in hryvnia" the English UI was
// reported for. `translate()` fills `{cur}` into every string automatically, so the fix at a call
// site is nothing at all — but only if the string uses the placeholder.
for (const [name, dict] of [["en.json", en], ["uk.json", uk]]) {
  for (const [k, v] of Object.entries(dict)) {
    // Only the hryvnia. "$" and "€" do appear legitimately — Anthropic bills in dollars, and an
    // FX account hint names the currencies it means. The hryvnia is the one that was standing in
    // for "whatever unit this app rolls up into", which is now a setting.
    if (typeof v === "string" && v.includes("₴") && !v.includes("{cur}")) {
      problems.push(`${name}: "${k}" spells out ₴ — use {cur}, which translate() fills in:\n    ${v}`);
    }
  }
}

// 4. A translation key ASSEMBLED at runtime is invisible to the parity check above (2026-08-21).
//
// The bug that bought this: the category page rendered `t(`imp.${data.importance}`)`, and the app
// printed the raw key «imp.optional» on every optional category. Parity did not care — `imp.*` was
// a two-entry pair belonging to a component that only ever shows two levels, and BOTH dictionaries
// were equally missing the third. tsc could not see it either: the key is a template literal cast
// to a sample member of the union.
//
// So a dynamic key has to declare the VALUES it can take, and every one of them is then checked
// like an ordinary key. The table is the exception list, and — per the rule that an exemption
// cites a fact and a fact can expire — each entry carries a date and a reason.
const DYNAMIC_KEYS = [
  { prefix: "cat.range.", values: ["month", "quarter", "year", "all"], since: "2026-08-14", why: "the category page's window selector" },
  // NOT every `GoalStatus`: `done` and `no_deadline` are the ABSENCE of a pace and are filtered
  // out before the badge renders (`Goals.tsx`). Listing them would demand two strings nothing
  // shows — the list must match what can reach `t()`, not what the type can hold.
  { prefix: "goal.pace.", values: ["on_track", "behind", "at_risk", "overdue"], since: "2026-08-12", why: "§GOAL-PACE verdicts that get a badge" },
  { prefix: "goal.kind.", values: ["save_up", "debt_payoff", "sinking_fund"], since: "2026-08-12", why: "`GOAL_KINDS` in lib/finance/goals.ts" },
  { prefix: "audit.source.", values: ["chat", "enrich", "resweep"], since: "2026-08-12", why: "§AI-AUDIT — which path wrote the change" },
  { prefix: "audit.field.", values: ["category_id", "is_transfer", "ai_note"], since: "2026-08-12", why: "§AI-AUDIT — the three fields a model may rewrite" },
  { prefix: "feedback.kind", values: ["Bug", "Idea", "Other"], since: "2026-08-01", why: "feedback inbox badges" },
  { prefix: "imp.", values: ["essential", "discretionary"], since: "2026-07-14", why: "SafeToSpend's two-level legend — NOT the three-level set, which is `IMPORTANCE_META`" },
];
for (const { prefix, values, since, why } of DYNAMIC_KEYS) {
  for (const v of values) {
    const key = prefix + v;
    if (!enKeys.has(key)) problems.push(`en.json missing "${key}" — built at runtime (${prefix}\${...}, since ${since}: ${why})`);
    if (!ukKeys.has(key)) problems.push(`uk.json missing "${key}" — built at runtime (${prefix}\${...}, since ${since}: ${why})`);
  }
}
// And the other direction: a dynamic key nobody declared is one nobody can check.
const DECLARED = new Set(DYNAMIC_KEYS.map((d) => d.prefix));
for (const file of walk(SRC)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\bt\(`([A-Za-z0-9_.]*?)\$\{/g)) {
      if (!DECLARED.has(m[1])) {
        problems.push(
          `${file}:${i + 1}  translation key built at runtime with an UNDECLARED prefix "${m[1]}".\n` +
          `    Neither tsc nor the parity check can see whether every value it can take exists.\n` +
          `    Add it to DYNAMIC_KEYS in this script (prefix, values, since, why), or resolve the\n` +
          `    key through a map the way \`IMPORTANCE_META\` does.`);
      }
    }
  });
}

if (problems.length) {
  console.error(`✗ i18n lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`✓ i18n lint: no hardcoded locale tags; en/uk in parity; ${DYNAMIC_KEYS.length} runtime-built key prefixes resolved`);
