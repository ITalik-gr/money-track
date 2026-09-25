#!/usr/bin/env node
/**
 * C20 — no CSS declaration that a later rule for the SAME selector always overrides.
 *
 * DESIGN.md §8 carried it as an open item for weeks: «8 selectors declared twice with different
 * bodies — today's render is their unwritten merge». Measured properly on 2026-09-25 it was 37
 * declarations across 20 rules: a property set once in, say, `domains-a.css` and set again for the
 * identical selector in `transactions.css`, which loads later and therefore always wins. The earlier
 * value never renders — it only misleads whoever reads it (the accent-tinted `.ai-card` in
 * domains-a.css that nobody has seen since the neutral restyle landed in transactions.css).
 *
 * They were removed and the removal was PROVEN render-neutral: the effective value of every property
 * of every top-level selector, computed across the whole `@import` cascade, was identical before and
 * after, and every conditional block byte-identical. This check keeps it that way.
 *
 * Scope, deliberately narrow so it has no false positives: both rules top-level (a rule inside
 * `@media` is C11's business), the SAME selector text, the SAME property name, different values,
 * no `!important`. A selector LIST on the earlier rule is reported only when the override covers
 * every selector in it — otherwise the declaration is live for the others.
 */
import { readFileSync } from "node:fs";

const order = readFileSync("src/index.css", "utf8").split("\n")
  .filter((l) => l.startsWith("@import"))
  .map((l) => l.split('"')[1].replace("./", "src/"));

/** Top-level rules, in cascade order: { file, selectors, props: Map<prop, value> }. */
function topLevel(file) {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let pos = 0;
  const head = /\s*([^{}]+)\{/y;
  while (pos < src.length) {
    head.lastIndex = pos;
    const m = head.exec(src);
    if (!m) break;
    let depth = 1, j = head.lastIndex;
    while (depth && j < src.length) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
    const sel = m[1].trim().replace(/\s+/g, " ");
    const body = src.slice(head.lastIndex, j - 1);
    if (!sel.startsWith("@") && !body.includes("{")) {
      const props = new Map();
      for (const decl of body.split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) props.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim().replace(/\s+/g, " "));
      }
      out.push({ file, selectors: sel.split(",").map((s) => s.trim()), props });
    }
    pos = j;
  }
  return out;
}

const rules = order.flatMap(topLevel);
const problems = [];
rules.forEach((early, i) => {
  for (const [prop, value] of early.props) {
    if (value.includes("!important")) continue;
    const overriddenFor = early.selectors.filter((sel) =>
      rules.slice(i + 1).some((late) => late.selectors.includes(sel) && late.props.has(prop) && late.props.get(prop) !== value));
    if (overriddenFor.length === early.selectors.length) {
      problems.push(`${early.file}: \`${early.selectors.join(", ")} { ${prop}: ${value} }\` — always overridden by a later rule`);
    }
  }
});

if (problems.length) {
  console.error("✗ C20 dead CSS declarations — a later rule for the same selector always wins:\n\n" +
    problems.map((p) => "  " + p).join("\n") +
    "\n\n  Delete the earlier declaration (it never renders), or merge the two rules into one.\n");
  process.exit(1);
}
console.log(`✓ C20 CSS: no declaration is silently overridden by a later rule for the same selector (${rules.length} rules)`);
