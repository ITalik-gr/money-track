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

if (problems.length) {
  console.error(`✗ i18n lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("✓ i18n lint: no hardcoded locale tags; en/uk dictionaries in parity");
