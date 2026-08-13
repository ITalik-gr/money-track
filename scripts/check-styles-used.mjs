#!/usr/bin/env node
/**
 * C9 — a class name and its rule must both exist.
 *
 * Bought by three bugs in one day (2026-08-14), all found by the owner on the live site and none
 * catchable by anything else in the repo:
 *   · `BankConnectionsCard` used `set-card` without `card`, so the block had no background at all;
 *   · the category page shipped `cat-page-stats`, `cat-page-dot`, `cat-page-children` and
 *     `cat-chip` with NO rules anywhere — three stat tiles meant to sit in a row stacked
 *     full-width, and sub-category links rendered as bare underlined text;
 *   · `cat-merch-list` likewise, so a merchant table was a paragraph.
 *
 * **A class name that matches nothing looks exactly like a class name that matches something.**
 * Neither `tsc` nor a CSS parser sees the join between them — it exists only at runtime, in a
 * browser, on a page someone has to open. That is precisely the shape of defect this repo answers
 * with a check rather than with care (CLAUDE.md: «Перевірка > інструкція»).
 *
 * Two directions, because the same seam fails both ways:
 *   1. **styleless** — a class used in a component with no rule in `src/styles/`. Renders unstyled.
 *   2. **dead** — a rule whose class no component ever names. Renders nothing, but it is read as
 *      live code forever after: it makes `domains-a.css` look bigger than the work it does, and it
 *      is what makes a split (STYLES phase 4) look more frightening than it is.
 *
 * ⚠️ **Interpolation is the hard case, and getting it wrong makes the check a liar.**
 * `` `toast toast-${t.type}` `` produces `toast-error` and `toast-info`, which appear NOWHERE as
 * literals. So every static prefix that sits immediately before a `${...}` is collected as a
 * DYNAMIC PREFIX, and any rule starting with one is treated as reachable. The cost is that a truly
 * dead `toast-*` rule survives; the alternative is a check that reports a false positive on day
 * one, and a check people learn to ignore is worse than no check.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STYLES = "src/styles";
const SRC = "src";

/**
 * Classes that legitimately have no rule of their own, with the reason. A NAMESPACE is a container
 * class that exists only to scope its children (`.whatif` has no rule, `.whatif-row` does) — it is
 * a real pattern, not an oversight, and forcing an empty rule for it would be worse.
 */
const STYLELESS_OK = new Set([
  // ── NAMESPACES: the container carries no rule of its own, its children do (`.whatif` is bare,
  //    `.whatif-row` is not). A real pattern; an empty rule to satisfy the check would be worse.
  "whatif", "eb", "eb-edit", "evt-plan", "rich", "who", "tag-group", "tag-pick", "tg-more",

  // ── MODIFIERS AND WRAPPERS THAT CURRENTLY DO NOTHING. Not namespaces — nothing anywhere reads
  //    them. Each is either a leftover or an intent never written, and telling those apart needs
  //    the page ON SCREEN: every one of them sits on Порадник / Підписки / Landing / Головна,
  //    which the owner has not reviewed live yet (ROADMAP «UI-черга»). Listed rather than deleted
  //    or invented, because guessing a style for a page I cannot see is how the `cat-page-*` bug
  //    got written in the first place.
  //    ⚠️ Shrink this list during the live design pass; do not grow it.
  "app",              // Login: the layout is inline `style`, so the class is decoration
  "alt",              // StatsTrends `.split-seg alt` — colour comes from inline `background`
  "tip-net",          // CashflowChart — colour comes from inline `style`
  "goal-jar",         // Goals — the colour comes from the inline `--goal-color`
  "advisor-main", "rev-name-txt", "grp-fact-label", "filt-sec-title",
  "pulse-cats", "pulse-save-main", "top-subs-card", "lp-top-signin", "ai-model-list",
]);

/** Rules kept although nothing names them, with the reason. */
const DEAD_OK = new Set([
  "modal-backdrop",   // written by the dialog polyfill/`::backdrop` fallback, not by a component
]);

/**
 * Class PREFIXES emitted at runtime by a library, so no source file will ever name them.
 *
 * ⚠️ This entry is the reason the sweep that introduced this check did not break every chart in
 * the app: `.recharts-surface`, `.recharts-tooltip-wrapper` and four others looked exactly as dead
 * as the 58 rules that really were. **A "dead code" check without this list is a delete-button
 * with a plausible explanation attached.**
 */
const THIRD_PARTY = ["recharts-"];

function walk(dir, out = [], ext = [".tsx", ".ts"]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, ext);
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// ---- what the stylesheets DEFINE -------------------------------------------
/** class -> file, for a useful error message. */
const defined = new Map();
for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) {
  const css = readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (!defined.has(m[1])) defined.set(m[1], f);
  }
}

// ---- what the components USE -----------------------------------------------
const usedStatic = new Map();   // class -> first file that names it in a className
const named = new Set();        // every bare token anywhere in src/ (a looser net, for `dead`)
const dynamicPrefixes = new Set();

/** Split a literal chunk of class text into tokens. */
const tokens = (s) => s.split(/\s+/).filter(Boolean);

for (const f of walk(SRC)) {
  const src = readFileSync(f, "utf8");

  // `className="a b c"` — fully static, so both directions can rely on it.
  for (const m of src.matchAll(/className="([^"]*)"/g)) {
    for (const t of tokens(m[1])) if (!usedStatic.has(t)) usedStatic.set(t, f);
  }

  // `` className={`a ${x} b-${y}`} `` — the static tokens are real uses; the fragment immediately
  // before an interpolation becomes a dynamic prefix.
  //
  // ⚠️ A token TOUCHING an interpolation is a fragment, not a class. `` `toast toast-${t.type}` ``
  // splits into "toast toast-" and "", and reporting `toast-` as a styleless class is the check
  // inventing a defect — which is how a check gets switched off. So the last token of a segment
  // followed by `${` is dropped, and so is the first token of a segment preceded by one.
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) {
    const body = m[1];
    const parts = body.split(/\$\{[^}]*\}/);
    parts.forEach((part, i) => {
      const ts = tokens(part);
      const touchesBefore = i > 0 && !/^\s/.test(part);          // glued to the previous ${…}
      const touchesAfter = i < parts.length - 1 && !/\s$/.test(part);
      const complete = ts.slice(touchesBefore ? 1 : 0, touchesAfter ? ts.length - 1 : ts.length);
      for (const t of complete) if (!usedStatic.has(t)) usedStatic.set(t, f);
    });
    for (const pm of body.matchAll(/([\w-]+)\$\{/g)) dynamicPrefixes.add(pm[1]);
  }

  // The loose net for direction 2: EVERY identifier-shaped run in the file. Deliberately crude —
  // a class handed through a prop, a lookup table or a ternary is still "named", and direction 2
  // should only ever fire when the name appears nowhere in the source at all. An earlier attempt
  // paired quotes to read only string literals; apostrophes in comments and nested template
  // literals desynchronise that scan, and it reported live classes as dead.
  for (const m of src.matchAll(/[\w-]+/g)) named.add(m[0]);
}

const problems = [];

// ---- direction 1: a class with no rule --------------------------------------
for (const [cls, file] of [...usedStatic].sort()) {
  if (defined.has(cls) || STYLELESS_OK.has(cls)) continue;
  problems.push(
    `${file}: className "${cls}" has no rule in ${STYLES}/.\n` +
    `    Either write the rule, or add it to STYLELESS_OK with the reason it needs none.`,
  );
}

// ---- direction 2: a rule nothing names --------------------------------------
for (const [cls, file] of [...defined].sort()) {
  if (named.has(cls) || DEAD_OK.has(cls)) continue;
  if (THIRD_PARTY.some((p) => cls.startsWith(p))) continue;
  if ([...dynamicPrefixes].some((p) => cls.startsWith(p))) continue;
  problems.push(
    `${STYLES}/${file}: .${cls} is never named by any component.\n` +
    `    Delete the rule — a dead rule reads as live code and makes the file look bigger than its work.`,
  );
}

if (problems.length) {
  console.error(`C9: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error("  " + p + "\n");
  process.exit(1);
}
console.log(`✓ C9: ${usedStatic.size} classes used, ${defined.size} defined, both directions clean`);
