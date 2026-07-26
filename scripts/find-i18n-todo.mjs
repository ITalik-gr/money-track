#!/usr/bin/env node
// i18n TODO locator (helper, NOT part of `npm run check`).
//
// Lists user-facing Ukrainian strings still awaiting translation, skipping what must NOT be
// touched: comments (// … and /* … */), and lines that already call t()/translate(). It is a
// HEURISTIC — it strips an inline `//` only when that `//` is not inside quotes, so a rare URL
// in a string could slip through; eyeball each hit. Use it to drive P3.2 file by file.
//
//   node scripts/find-i18n-todo.mjs            → grouped by file, with counts
//   node scripts/find-i18n-todo.mjs src/pages/Stats.tsx   → one file
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CYR = /[Ѐ-ӿ]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// Remove an inline `//` comment, but only when the `//` sits outside single/double/backtick
// quotes. Good enough for this codebase's lines.
function stripInlineComment(line) {
  let q = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\") i++;
    } else if (c === '"' || c === "'" || c === "`") {
      q = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

const targets = process.argv[2] ? [process.argv[2]] : walk("src");
let total = 0;

for (const file of targets) {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits = [];
  let inBlock = false;
  lines.forEach((raw, idx) => {
    let line = raw;
    // Handle /* … */ block comments (possibly spanning lines).
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return; // whole line is comment
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Drop any complete /* … */ on this line, and open a block if it starts one.
    line = line.replace(/\/\*[^]*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open !== -1) {
      inBlock = true;
      line = line.slice(0, open);
    }
    line = stripInlineComment(line);
    if (line.trim().startsWith("*")) return; // JSDoc continuation
    if (!CYR.test(line)) return;
    hits.push({ n: idx + 1, text: raw.trim() });
  });
  if (hits.length) {
    console.log(`\n${file}  (${hits.length})`);
    for (const h of hits) console.log(`  ${h.n}: ${h.text}`);
    total += hits.length;
  }
}
console.log(`\n= ${total} user-facing Ukrainian line(s) left (heuristic)`);
