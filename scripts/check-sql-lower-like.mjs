#!/usr/bin/env node
/**
 * C16 — no `LOWER(…) LIKE` in worker SQL (§CYR-CASE).
 *
 * SQLite folds case for ASCII only. `LOWER('Київстар')` is still `'Київстар'`, and `LIKE` is
 * case-insensitive for ASCII only, so `LOWER(t.merchant) LIKE '%київстар%'` looks like a
 * case-insensitive match and is not one — for the app's main language it silently finds nothing.
 * It bit three times before this check existed: `linkPlanHistory` (a plan could not find its own
 * history, 2026-09-21), then `consensusCategory` and `findSimilar` (2026-09-25). Each was fixed
 * by hand after a real miss; this check is what makes the fourth one fail the build instead.
 *
 * The fix is `orLikeClause` / `likeVariants` from `worker/lib/platform/text.ts`: the spellings are
 * built in JS, which folds Unicode, and OR-matched in SQL.
 *
 * Reads STRING LITERALS only, through the TypeScript parser — so prose that explains the rule in
 * a comment (and several do, by name) is not a violation, while a query assembled across a
 * template's `${…}` parts still is.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// A directory argument exists for probing the check itself against a scratch copy.
const ROOT = process.argv[2] ?? "worker";

function* tsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "node_modules") continue;
      yield* tsFiles(p);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".generated.ts")) {
      yield p;
    }
  }
}

/** The literal text of every string / template in a file — a template's static parts joined. */
function stringsOf(file) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ${…} ");
      out.push({ text, line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

// `LOWER(<anything without a closing paren chain>) … LIKE` inside one string.
const LOWER_LIKE = /\bLOWER\s*\([^;]*?\)\s*(NOT\s+)?LIKE\b/i;

const problems = [];
for (const file of tsFiles(ROOT)) {
  for (const s of stringsOf(file)) {
    if (LOWER_LIKE.test(s.text)) problems.push(`${file}:${s.line}`);
  }
}

if (problems.length) {
  console.error(
    "✗ C16 §CYR-CASE: `LOWER(…) LIKE` in worker SQL — SQLite folds ASCII only, so it never matches Cyrillic.\n" +
    "  Use `orLikeClause` / `likeVariants` from worker/lib/platform/text.ts.\n\n" +
    problems.map((p) => "  " + p).join("\n") + "\n",
  );
  process.exit(1);
}
console.log("✓ C16 §CYR-CASE: no `LOWER(…) LIKE` in worker SQL");
