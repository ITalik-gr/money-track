#!/usr/bin/env node
/**
 * C11 — a conditional rule that a later unconditional rule silently kills.
 *
 * `@media` (and `@container`) add ZERO specificity. So `@media (max-width: 560px) { .x { … } }`
 * beats an unconditional `.x { … }` only while it sits LATER in the cascade. Move the layout to a
 * part imported further down — or write the unconditional copy below it in the same part — and the
 * responsive rule loses every time, with no error, no warning and nothing on screen to point at.
 * The condition is still in the file, still reads as if it works, and does nothing.
 *
 * Why this is a check and not a note in a document: it had already happened twice before anyone
 * went looking. `.settings-grid { columns: 1 }` stayed in `settings.css` when the layout moved to
 * `settings-shell.css`, and Settings was unreadable on a phone until 2026-08-22. Then a probe over
 * the whole cascade on 2026-09-04 found EIGHT more standing cases, three of which were breaking a
 * screen at that moment — including `prefers-reduced-motion` doing nothing for §WEEKDAY, i.e. an
 * accessibility opt-out that had been dead for weeks. Nobody was going to see these by reading:
 * the two halves live in different files, hundreds of lines and several imports apart.
 * §Правила: «перевірка > інструкція».
 *
 * What it proves, and the deliberate limits on what it claims:
 *   - Selectors are compared for EXACT equality after normalisation. That makes specificity a
 *     non-question (identical selectors have identical specificity), so every report is a real
 *     override rather than a guess about whether `.a .b` and `.b` can match the same element.
 *     It under-reports by design; a lint that cries wolf gets an allowlist and then gets ignored.
 *   - Properties are compared by exact name. `gap: 8px` killed by a later `row-gap` is real and
 *     NOT reported — expanding shorthands means encoding the whole shorthand table, and a wrong
 *     entry there would delete a rule someone needs.
 *   - `!important` is tracked: an important conditional declaration is not killed by a plain
 *     unconditional one, so it is not reported.
 *   - `@keyframes` is skipped entirely — `from`, `to` and `50%` are not selectors and two keyframe
 *     blocks with the same name are a different bug (C9's territory, not this one).
 */
import { readFileSync } from "node:fs";

const INDEX = "src/index.css";
const DIR = "src/styles";

/**
 * Known-and-accepted cases, `selector|property` with a REASON on every line.
 *
 * Same contract as C8's exceptions and `STYLELESS_OK` in C9: an entry is a debt with a name on it,
 * and the list may only shrink. Empty is the goal state and the state it shipped in — an allowlist
 * that starts populated teaches the next person that adding a line is how you make the lint quiet.
 */
const ACCEPTED = new Map([
  // ["selector|prop", "why this one is genuinely fine"],
]);

// ── tokenizer ──────────────────────────────────────────────────────────────────────────────────
//
// Hand-written rather than a dependency: the whole job is "walk the declarations in source order
// and remember which at-rules enclose each one", which no CSS parser package does more safely than
// forty lines do, and a build-time dependency that can rewrite the stylesheet is a bigger risk
// than this loop is.

/** Strip comments, keeping every newline so reported line numbers stay true to the file. */
function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const cut = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += cut.replace(/[^\n]/g, " ");
      i += cut.length - 1;
      continue;
    }
    // A string can hold a `/*` that is not a comment (`content: "/*"`), so strings are copied whole.
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && (src[j] !== q || src[j - 1] === "\\")) j++;
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    out += src[i];
  }
  return out;
}

/** Split a selector list on top-level commas — `:is(.a, .b)` must stay one selector. */
function splitSelectors(list) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

function parseDeclarations(body, file, startLine, selectors, conditions, sink) {
  let line = startLine;
  for (const chunk of body.split(";")) {
    const nl = (chunk.match(/\n/g) || []).length;
    const colon = chunk.indexOf(":");
    if (colon > 0) {
      const prop = chunk.slice(0, colon).trim();
      let value = chunk.slice(colon + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/!\s*important$/i, "").trim();
      // Custom properties (`--x`) hold arbitrary text and are inherited, not overridden the same
      // way; a plain declaration name is what this check is about.
      if (/^[a-z-]+$/.test(prop) && !prop.startsWith("--") && value) {
        // The declaration's own line is where its NAME is, not where the chunk began.
        const before = (chunk.slice(0, colon).match(/\n/g) || []).length;
        for (const selector of selectors) {
          sink.push({ file, line: line + before, selector, prop, value, important, conditions });
        }
      }
    }
    line += nl;
  }
}

/** Walk one file, emitting every declaration with the at-rule conditions enclosing it. */
function parseFile(file, src, sink) {
  const s = stripComments(src);
  const lineAt = (i) => (s.slice(0, i).match(/\n/g) || []).length + 1;

  // Iterative walk over balanced blocks. `stack` carries the enclosing conditions.
  const walk = (from, to, conditions) => {
    let i = from;
    let prelude = "";
    let preludeStart = i;
    while (i < to) {
      const ch = s[i];
      if (ch === "{") {
        // Find the matching close.
        let depth = 1, j = i + 1;
        while (j < to && depth > 0) {
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        const bodyStart = i + 1, bodyEnd = j - 1;
        const head = prelude.trim().replace(/\s+/g, " ");
        if (head.startsWith("@")) {
          const name = head.slice(1).split(/[\s(]/)[0].toLowerCase();
          if (name === "keyframes" || name === "font-face" || name === "property") {
            // Not selectors. Skipped rather than parsed — see the header.
          } else if (name === "media" || name === "container" || name === "supports") {
            walk(bodyStart, bodyEnd, [...conditions, head]);
          } else {
            walk(bodyStart, bodyEnd, conditions);
          }
        } else if (head) {
          parseDeclarations(
            s.slice(bodyStart, bodyEnd), file, lineAt(bodyStart),
            splitSelectors(head), conditions, sink,
          );
        }
        i = j;
        prelude = "";
        preludeStart = i;
        continue;
      }
      if (ch === "}") { i++; prelude = ""; preludeStart = i; continue; }
      if (ch === ";" && prelude.trim().startsWith("@")) { i++; prelude = ""; preludeStart = i; continue; }
      prelude += ch;
      i++;
    }
  };
  walk(0, s.length, []);
}

// ── the check ──────────────────────────────────────────────────────────────────────────────────

const index = readFileSync(INDEX, "utf8");
// ⚠️ The @import ORDER is the cascade — `index.css` says so in its own header, and this check is
// only meaningful read in that order. Reading the directory instead would sort alphabetically and
// quietly answer a different question.
const order = [...index.matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]);

const decls = [];
for (const f of order) parseFile(f, readFileSync(`${DIR}/${f}`, "utf8"), decls);

/**
 * Index by `selector|prop` so the scan is linear rather than quadratic: 8 000+ declarations is
 * small, but a check that gets slow gets moved out of `npm run check`, and then it is not a check.
 */
const byKey = new Map();
decls.forEach((d, i) => {
  const key = `${d.selector}|${d.prop}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(i);
});

const problems = [];
for (const [key, positions] of byKey) {
  if (positions.length < 2) continue;
  const [selector, prop] = key.split("|");
  for (let a = 0; a < positions.length; a++) {
    const dead = decls[positions[a]];
    if (!dead.conditions.length) continue;
    // The killer: the FIRST later unconditional declaration that outranks it.
    const killerIdx = positions.slice(a + 1).find((p) => {
      const u = decls[p];
      return !u.conditions.length && !(dead.important && !u.important);
    });
    if (killerIdx === undefined) continue;
    if (ACCEPTED.has(key)) continue;
    const killer = decls[killerIdx];
    // Is the CONDITION lost, or only this copy of it? A later conditional declaration with the
    // same condition still fires, which makes this copy dead code rather than a broken screen —
    // a real difference to whoever reads the report at 3am, so the report states which it is.
    const revived = positions.some((p) => {
      const c = decls[p];
      return p > killerIdx && c.conditions.join("&&") === dead.conditions.join("&&");
    });
    problems.push(
      `${dead.file}:${dead.line}  ${selector} { ${prop}: ${dead.value} }  ${dead.conditions.join(" ")}\n` +
      `      killed by ${killer.file}:${killer.line} — unconditional ${prop}: ${killer.value}\n` +
      `      ${revived
        ? "a later copy of the same condition still fires: this one is dead code, not a broken screen."
        : "⚠ the condition is LOST — nothing else restores it, so this rule never applies."}`);
  }
}

if (problems.length) {
  console.error(
    `✗ C11 conditional rules killed by a later unconditional one (${problems.length}):\n\n  ` +
    problems.join("\n\n  ") +
    "\n\n  @media adds no specificity, so a later unconditional declaration wins outright.\n" +
    "  Fix by moving the conditional rule below its unconditional twin in the cascade\n" +
    `  (the @import order in ${INDEX}), or by deleting the copy that never applies.\n`);
  process.exit(1);
}
console.log(`✓ C11 cascade: ${decls.length} declarations across ${order.length} parts, no conditional rule is overridden`);
