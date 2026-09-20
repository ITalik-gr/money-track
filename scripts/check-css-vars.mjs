#!/usr/bin/env node
/**
 * C15 — a `var(--x)` must resolve to a `--x` that something actually defines.
 *
 * Bought on 2026-09-21 by the business page. `fop.css` was written against SEVEN custom properties
 * that exist nowhere in this project — `--text`, `--text-dim`, `--c-red`, `--c-red-soft`,
 * `--c-green`, `--bg-soft`, `--c-teal-soft` — sixty-five uses in one file. The owner's report was
 * «на сторінці гапів немає між блоками, та і в блоках… і не дуже там сторінка зрозуміла», and
 * that is exactly what an undefined variable looks like from the outside:
 *
 *   · `color: var(--text-dim)` — the declaration is INVALID AT COMPUTED-VALUE TIME, so the element
 *     inherits instead. Every dim label rendered at full strength, and a page whose hierarchy is
 *     built from two text weights had one.
 *   · `background: var(--bg-soft)` — transparent. The «next payment» panel had no panel.
 *   · `background: var(--c-teal-soft)` on `.fop-rank-bar` — the proportion bar behind every client
 *     and every cost row was invisible, so two ranked lists read as plain text.
 *   · `border-color: var(--c-red)` — dropped, so «overdue» looked identical to «due».
 *
 * **Nothing else in the repo could see it.** TypeScript does not read CSS; C8/C9 check FILES and
 * CLASS NAMES, not values; the browser fails silently by design. It is the same shape as C9 — a
 * join that exists only at runtime — and it gets the same answer: a check, not care.
 *
 * Definitions are collected from anywhere: `src/styles/*.css` (a token, or a local `--x:` on a
 * component's own rule) AND inline `style={{ "--x": … }}` in TSX, which is how the per-row colours
 * (`--chip-color`, `--goal-color`, `--rng-a`) are set. A variable given a FALLBACK — `var(--x, …)`
 * — is deliberately allowed: that is the one form which states what happens when it is missing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = "src/styles";
const SRC = "src";

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const cssFiles = readdirSync(STYLES).filter((f) => f.endsWith(".css")).map((f) => join(STYLES, f));
const tsxFiles = walk(SRC).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

const defined = new Set();
for (const f of cssFiles) {
  for (const m of readFileSync(f, "utf8").matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
}
// Inline custom properties: `style={{ "--goal-color": c }}`. Set by the component, so the CSS rule
// that reads them is correct and only LOOKS undefined from inside the stylesheets.
for (const f of tsxFiles) {
  for (const m of readFileSync(f, "utf8").matchAll(/["'](--[a-zA-Z0-9-]+)["']\s*:/g)) defined.add(m[1]);
}

const bad = [];
for (const f of cssFiles) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // `var(--x)` with no comma: a fallback is a deliberate statement about absence, so it passes.
    for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
      if (!defined.has(m[1])) bad.push({ file: f, line: i + 1, name: m[1] });
    }
  });
}

if (bad.length) {
  console.error("✗ C15 css vars: used but never defined (the declaration is dropped at runtime):\n");
  const byName = new Map();
  for (const b of bad) {
    if (!byName.has(b.name)) byName.set(b.name, []);
    byName.get(b.name).push(`${b.file}:${b.line}`);
  }
  for (const [name, where] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${name} — ${where.length} use(s)`);
    for (const w of where.slice(0, 4)) console.error(`      ${w}`);
    if (where.length > 4) console.error(`      … and ${where.length - 4} more`);
  }
  console.error("\n  Define it in tokens.css, set it inline on the element, or give var() a fallback.");
  process.exit(1);
}

console.log(`✓ C15 css vars: every var() resolves (${defined.size} defined)`);
