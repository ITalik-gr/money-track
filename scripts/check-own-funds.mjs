#!/usr/bin/env node
/**
 * C14 — «own funds» is computed in ONE place: `shared/own-funds.ts`.
 *
 * THE RULE (`CLAUDE.md`, hard invariants): a credit card's `balance` includes the bank's limit, so
 * owned money is `balance − credit_limit`, and a card in debt keeps a NEGATIVE result. Debt is the
 * same number seen from the other side, never a second formula.
 *
 * WHY A CHECK NOW. `own-funds.ts` was written after FOUR copies of that expression were found, and
 * its own header says «the fifth copy is where a project like this loses an evening». The fifth
 * and sixth were then written anyway — on the Accounts page, where they could not import the
 * module because it sat in `worker/lib/`. Both agreed with the server by luck; the clamp that did
 * NOT agree (`Math.max(own, 0)`) had already cost one evening, with the page total and the
 * dashboard cushion disagreeing about the same card.
 *
 * So the module moved to `shared/` (2026-09-18) and this is the thing that keeps it the only copy.
 * A prose warning inside the file it protects is read by whoever is editing THAT file, which is
 * never the person about to write the seventh copy somewhere else.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["worker", "src", "shared"];
const OWNER = "own-funds.ts";

/**
 * `balance` and `credit_limit` on one line with a `-` between them, either order. Deliberately
 * narrow: a SELECT listing both columns has no minus, and the two never meet in arithmetic for any
 * other reason — the whole point is that there IS no other question with that shape.
 */
const RE = /balance[^;\n]{0,40}-[^;\n]{0,20}credit_?[lL]imit|credit_?[lL]imit[^;\n]{0,40}-[^;\n]{0,20}balance/;

function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(e.name) && e.name !== OWNER) out.push(p);
  }
  return out;
}

const problems = [];
for (const root of ROOTS) {
  for (const file of files(root)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (RE.test(line)) {
        problems.push(
          `${file}:${i + 1}: computes own funds inline.\n` +
          `    Use ownFundsMinor()/debtMinor() from shared/own-funds.ts — a second expression for\n` +
          `    one number is how the Accounts total and the dashboard cushion came to disagree.\n` +
          `    ${code.slice(0, 110)}`,
        );
      }
    });
  }
}

if (problems.length) {
  console.error("✗ C14 own funds:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}
console.log("✓ C14 own funds: `balance − credit_limit` appears only in shared/own-funds.ts");
