#!/usr/bin/env node
/**
 * C22 — §ROW-LIST: a list of rows inside a card draws its separators through `.ilist` only.
 *
 * THE DEFECT (owner's review, 2026-09-25, screens 4, 5, 11, 13): every list had invented its own
 * hairlines — `li + li { border-top }`, `.row { border-bottom }`, `> div + div` — and then its own
 * rounded hover fill. A rounded fill touching square lines looks broken, and in a flush card the
 * first/last row's fill left a strip of padding. `.ilist` (controls.css) fixes both once: inset
 * list, rounded rows, inset separators that vanish beside a hovered or opened row.
 *
 * WHAT IS REFUSED, in every stylesheet but the pattern's own block:
 *   1. a sibling-combinator rule (`a + b`) drawing a `border-top|bottom` in `var(--line)` between
 *      rows that have a hover fill, or between children the rule cannot name (`> *`, `li`, `div`) —
 *      the hand-made separator. Plain rows nobody hovers (settings rows, forecast lines) keep
 *      their hairlines: with no fill there is nothing for a line to collide with;
 *   2. a class that has a `:hover` background AND a `border-top|bottom` in `var(--line)` on its
 *      own rule — a row that is both separated and filled, which is the broken picture itself.
 * A TABLE-like list whose rows run edge to edge (clipped by the card's radius) is the one
 * legitimate other shape; each is listed below with the fact that makes it one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/styles";
const SKIP_FILES = new Set(["landing.css"]); // marketing rhythm lives there by rule (DESIGN §8)

/** Edge-to-edge lists: rows touch the card edge and `overflow: hidden` + radius clip the fill. */
const OK = {
  ".ledger.rows": "the transaction TABLE — rows run edge to edge inside an overflow-hidden card",
  ".tx": "the ledger ROW that `.ledger.rows` is made of — the same edge-to-edge table",
  ".nt-row": "the notification feed — edge to edge inside `.nt-list { overflow: hidden; border-radius: inherit }`",
};

const SEP = /border-(top|bottom)\s*:[^;]*var\(--line\)/;

function rules(css) {
  const out = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Flat scan; @media/@container bodies are scanned the same way (their inner rules match too).
  const re = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

const problems = [];
for (const f of readdirSync(DIR).filter((n) => n.endsWith(".css") && !SKIP_FILES.has(n))) {
  const all = rules(readFileSync(join(DIR, f), "utf8"));
  const hoverFilled = new Set();
  for (const r of all) {
    for (const s of r.sel.split(",")) {
      const hm = /^\s*(\.[\w-]+)[^,\s]*:hover\s*$/.exec(s);
      if (hm && /background\s*:/.test(r.body)) hoverFilled.add(hm[1]);
    }
  }
  for (const r of all) {
    if (!SEP.test(r.body)) continue;
    for (const s of r.sel.split(",").map((x) => x.trim())) {
      if (s.startsWith(".ilist")) continue;
      if (Object.keys(OK).some((k) => s.startsWith(k))) continue;
      const sib = /\S\s*\+\s*(\S+)$/.exec(s);
      const last = sib && /^(\.[\w-]+)/.exec(sib[1])?.[1];
      if (sib && (!last || hoverFilled.has(last))) {
        problems.push(`${DIR}/${f}: \`${s}\` draws a separator by hand — put the list in \`.ilist\` (§ROW-LIST).`);
        continue;
      }
      const cls = /^(\.[\w-]+)/.exec(s)?.[1];
      if (cls && hoverFilled.has(cls) && s === cls) {
        problems.push(`${DIR}/${f}: \`${cls}\` has a hover fill AND its own hairline — a rounded fill meets a square line (§ROW-LIST).`);
      }
    }
  }
}

if (problems.length) {
  console.error("✗ C22 §ROW-LIST:\n\n" + problems.map((p) => "  " + p).join("\n") + "\n");
  process.exit(1);
}
console.log(`✓ C22 §ROW-LIST: row separators only from .ilist (${Object.keys(OK).length} edge-to-edge lists, each with its reason)`);
