#!/usr/bin/env node
/**
 * C19 — an exported name nothing uses is either used or gone.
 *
 * Measured 2026-09-25: 17 exports were referenced by no other file AND not used in their own. Most
 * were plain leftovers (a password-login helper after Google-only sign-in, a second writer of advice
 * outcomes beside the one that runs, a test seam no test used). Two were not: `markVerified` (a
 * token that expires after it was saved is never recorded — kept, see ROADMAP) and the search
 * rerank that is measured but not wired. Every one of those was found by reading, which is the
 * part a lint cannot do; what it CAN do is stop the pile from growing back.
 *
 * «Dead» here is strict: not referenced in any other source file (tests and scripts count as
 * users), and not used again inside its own file. An export used only locally is a different,
 * harmless thing (a type named for documentation) and is not flagged.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["worker", "src", "shared", "scripts"];
const EXPORT = /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_]\w*)/gm;

/** Exported and unused on purpose. Each with its reason; the list only shrinks. */
const KEEP = {
  RootState: "Redux convention — the store's type, for typed hooks when they are added",
  AppDispatch: "Redux convention — same",
  JUDGED_MIN_SCORE: "the measured-but-unwired search rerank line (§JEV-EVAL); re-measured by scripts/eval-sites.mjs",
};

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__golden__" || name === "__eval__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|mjs)$/.test(p) && !p.endsWith(".generated.ts")) yield p;
  }
}

const text = new Map();
for (const r of ROOTS) for (const f of files(r)) text.set(f, readFileSync(f, "utf8"));

const dead = [];
for (const [file, src] of text) {
  if (file.startsWith("scripts/") || file.includes("/test/")) continue;
  for (const m of src.matchAll(EXPORT)) {
    const name = m[1];
    if (KEEP[name]) continue;
    const re = new RegExp(`\\b${name}\\b`);
    const localUses = src.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
    if (localUses > 1) continue;
    let used = false;
    for (const [other, t] of text) if (other !== file && re.test(t)) { used = true; break; }
    if (!used) dead.push(`${file} :: ${name}`);
  }
}

if (dead.length) {
  console.error("✗ C19 dead exports — referenced nowhere, not even in their own file:\n\n" +
    dead.map((d) => "  " + d).join("\n") + "\n\n  Use it or delete it (or, rarely, list it in KEEP with its reason).\n");
  process.exit(1);
}
console.log(`✓ C19 dead exports: none (${Object.keys(KEEP).length} kept on purpose, each with its reason)`);
