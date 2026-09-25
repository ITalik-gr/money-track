#!/usr/bin/env node
/**
 * C18 — every §TAG the code cites is defined in a document.
 *
 * A § in a comment is a pointer: «§PLAN-LATE» means «the rule is written down, go and read it».
 * A pointer to nothing is worse than no pointer — it looks like provenance and is not. On
 * 2026-09-25 the code cited 179 distinct tags and 49 of them were defined nowhere: roadmap card
 * ids from finished rounds (§R2-ST1, §CH4, §A2…) whose cards were deleted as the process demands,
 * leaving the pointer behind.
 *
 * Defining 55 historical tags after the fact would be invention, so this is a RATCHET, the same
 * shape as C1's budget: the 49 are listed below as LEGACY and may only shrink (a tag that
 * disappears from the code must be deleted from the list), and any tag NOT on the list must be
 * defined in CLAUDE.md, docs/*.md or DESIGN.md. New work names its rule where it writes it.
 *
 * Latin-uppercase tags only: the Cyrillic ones (§Хвіст, §Інваріанти) are section words, not ids.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TAG = /§[A-Z][A-Z0-9_-]*[A-Z0-9]/g;
const CODE_ROOTS = ["worker", "src", "shared", "scripts"];
const DOCS = ["CLAUDE.md", "DESIGN.md", ...readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => join("docs", f))];
const SELF = "scripts/check-section-index.mjs";

/** Cited in code, defined nowhere, as of 2026-09-25. ONLY EVER SHRINKS. */
const LEGACY = new Set([
  "§A2", "§A3", "§A5", "§ADV-METRICS", "§AGENT", "§B1", "§BUDGET", "§C1", "§C2", "§CANON",
  "§CAT-LEAF", "§CAT2", "§CH4", "§CTX", "§D4", "§D5", "§E4", "§EFF_IMPORTANCE", "§F1", "§F3",
  "§F4", "§F5", "§G1", "§G2", "§GR2", "§P2", "§P3", "§P4", "§PERIMETER", "§PLATFORM",
  "§PRICE-DRIFT", "§R2-CUR1", "§R2-CUR2", "§R2-ST1", "§R2-ST2", "§R2-ST3", "§R2-ST4", "§R2-ST5",
  "§R2-TX1", "§R2-TX2", "§R2-TX3", "§R2-TX4", "§R5", "§R6", "§R7", "§ROADMAP", "§SUB4", "§TAX",
  "§TG-CSV",
]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__golden__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|mjs)$/.test(p) && !p.endsWith(".generated.ts") && p !== SELF) yield p;
  }
}

const defined = new Set();
for (const d of DOCS) for (const m of readFileSync(d, "utf8").matchAll(TAG)) defined.add(m[0]);

const cited = new Map();
for (const root of CODE_ROOTS) {
  for (const f of files(root)) {
    for (const m of readFileSync(f, "utf8").matchAll(TAG)) if (!cited.has(m[0])) cited.set(m[0], f);
  }
}

const problems = [];
for (const [tag, where] of cited) {
  if (!defined.has(tag) && !LEGACY.has(tag)) problems.push(`${tag} — cited in ${where}, defined in no document`);
}
for (const tag of LEGACY) {
  if (!cited.has(tag)) problems.push(`${tag} — listed as LEGACY but no longer cited; delete it from the list`);
  else if (defined.has(tag)) problems.push(`${tag} — listed as LEGACY but now defined; delete it from the list`);
}

if (problems.length) {
  console.error("✗ C18 § index:\n\n" + problems.map((p) => "  " + p).join("\n") +
    "\n\n  A new rule gets its line in CLAUDE.md / docs/CANON.md / DESIGN.md where the code names it.\n");
  process.exit(1);
}
console.log(`✓ C18 § index: ${cited.size} tags cited, all defined (${LEGACY.size} legacy, shrinking)`);
