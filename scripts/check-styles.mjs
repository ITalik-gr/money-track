#!/usr/bin/env node
/**
 * C8 — the stylesheet stays split.
 *
 * `src/index.css` was one file of 4 182 lines. Splitting it is worth nothing on its own: the same
 * pressure that produced it (there is only one place a rule CAN go) would rebuild it within
 * months. This is the check that makes the split a property of the repo rather than a tidy-up —
 * the same instrument as C3, and for the same reason: `routes/api.ts` is not 3 331 lines any more
 * because a check refuses to let it grow back.
 *
 * What it enforces, and why each one:
 *   1. `index.css` contains ONLY `@import` lines and comments. The moment it accepts one real
 *      rule it will accept the next thousand.
 *   2. Every file in `src/styles/` is imported by it. A stylesheet nobody imports is dead code
 *      that still looks alive.
 *   3. No part exceeds a line ceiling. Not sacred — like C3 it exists to force a DECISION about
 *      whether a new part has appeared, at a moment when someone is looking.
 *
 * NOT enforced (deliberately): that a class prefix matches its file. It needs a real CSS parser
 * and would fight legitimate cross-domain rules like `.dash-pair > :only-child`. A check should be
 * spent where discipline actually fails.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const INDEX = "src/index.css";
const DIR = "src/styles";
/**
 * The ceiling. Two parts are over it today (`domains-a`, `settings`) — they are the untouched
 * middle of the original file, and splitting them further means REGROUPING rules across cascade
 * boundaries, which changes which rule wins and needs a visual check (STYLES.md phase 4). They are
 * listed as exceptions rather than the limit being raised to fit them: an exception is a debt with
 * a name on it, a raised limit is a limit nobody believes.
 */
const MAX_LINES = 700;
/**
 * An exception is a debt with a name on it, so it RATCHETS: when the file shrinks, the number
 * comes down with it and the slack is gone for good.
 *
 * 2026-08-14: the C9 dead-rule sweep took `domains-a.css` 1 156 → 1 104 and `settings.css`
 * 675 → 637 — the second is now under the cap on its own, so **its exception is deleted rather
 * than kept as headroom.** That is the point of the mechanism: an exception nobody needs is an
 * invitation to grow back into it.
 */
// 2026-08-22: 1105 → 1000. The chat page's phone layout pushed this part 26 lines over, and an
// exception may never rise — so the chat block became `chat.css`, the fourteenth part, and the
// cap follows the file DOWN. A cap left at its old height is headroom nobody decided to grant.
// 2026-08-27: 1000 → 948. §SUB-PAGE pushed it one line over, and the ratchet held again — the
// whole subscriptions block (its largest) became `subscriptions.css`, the sixteenth part, and the
// cap follows the file down rather than being nudged up by one.
const EXCEPTIONS = { "domains-a.css": 949 };

const problems = [];

const index = readFileSync(INDEX, "utf8");
// Strip block comments, then anything left that is not an @import is a rule sneaking in.
const stripped = index.replace(/\/\*[\s\S]*?\*\//g, "");
for (const [i, line] of stripped.split("\n").entries()) {
  const t = line.trim();
  if (!t || t.startsWith("@import ")) continue;
  problems.push(`${INDEX}:${i + 1}: only @import lines belong here, found: ${t.slice(0, 60)}`);
}

const imported = new Set([...index.matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]));
const present = readdirSync(DIR).filter((f) => f.endsWith(".css"));

for (const f of present) {
  if (!imported.has(f)) problems.push(`${DIR}/${f} is never imported by ${INDEX} — dead stylesheet.`);
}
for (const f of imported) {
  if (!present.includes(f)) problems.push(`${INDEX} imports ${f}, which does not exist.`);
}
for (const f of present) {
  const n = readFileSync(join(DIR, f), "utf8").split("\n").length;
  const cap = EXCEPTIONS[f] ?? MAX_LINES;
  if (n > cap) {
    problems.push(
      `${DIR}/${f}: ${n} lines, ${EXCEPTIONS[f] ? `exception allows ${cap}` : `cap is ${MAX_LINES}`}.\n` +
      `    An exception may never rise. Split the part instead — see STYLES.md.`);
  }
}

if (problems.length) {
  console.error("✗ C8 styles:\n\n  " + problems.join("\n  ") + "\n");
  process.exit(1);
}
console.log(`✓ C8 styles: ${present.length} parts, all imported, index is imports only`);
