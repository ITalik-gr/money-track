#!/usr/bin/env node
/**
 * C17 — a component that renders `… ?? []` from a query must also handle the query FAILING.
 *
 * CLAUDE.md has said it for months: «a page with `data?.x ?? []` must have an error branch». It was
 * an instruction, so it held exactly as well as memory did: on 2026-09-25 four places broke it —
 * the Merchant page, the capital trend card, the what-if sliders and the health mini-card. Each
 * rendered a failed request as «nothing here», which is the specific lie §Обробка помилок forbids:
 * empty and broken must look different.
 *
 * The rule, mechanically: a `.tsx` file under `src/pages` or `src/components` (not `ui/`, which has
 * no queries by rule) that calls a `use…Query(` hook AND contains `?? []` must reference one of
 * `ErrorNote`, `isError`, or an `error` taken from a query result. A heuristic — so the exceptions
 * are listed with their reason, and the list may only SHRINK.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages", "src/components"];

/** Files where `?? []` is not the page's content. Each needs a reason; the list only shrinks. */
const EXCEPTIONS = {
  // Categories are read only to COLOUR fact chips; with no categories the facts still render.
  "src/components/advisor/RichFacts.tsx": "decorative lookup (chip colours)",
  // OPTIONS for a picker, not the screen's content: an empty dropdown after a failed request is
  // already announced by `apiErrorMiddleware`'s toast, and the form around it still works.
  "src/pages/Add.tsx": "picker options (accounts, categories, frequent)",
  "src/components/planning/SubSettings.tsx": "picker options (categories)",
  "src/components/transactions/TransferReviewModal.tsx": "picker options (categories)",
  "src/components/transactions/TxSplitEditor.tsx": "picker options (categories)",
  // A background indicator polled every few seconds; an error note there would flash on every
  // transient failure. The jobs themselves report failure in the feed.
  "src/components/layout/AiJobs.tsx": "polled background indicator",
};

function* tsx(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (p !== "src/components/ui") yield* tsx(p); }
    else if (p.endsWith(".tsx")) yield p;
  }
}

const problems = [];
for (const root of ROOTS) {
  for (const file of tsx(root)) {
    const src = readFileSync(file, "utf8");
    if (!/\buse[A-Z]\w*Query\(/.test(src) || !src.includes("?? []")) continue;
    const handles = /\bErrorNote\b|\bisError\b|\berror\s*[,}:]|\berror:\s*\w+/.test(src);
    if (handles || EXCEPTIONS[file]) continue;
    problems.push(file);
  }
}
for (const f of Object.keys(EXCEPTIONS)) {
  try { readFileSync(f); } catch { problems.push(`${f} — listed in EXCEPTIONS but gone; delete the line`); }
}

if (problems.length) {
  console.error(
    "✗ C17 error branch: a component renders `?? []` from a query and never handles the query failing.\n" +
    "  Add `<ErrorNote error={error} … />` (or an `isError` branch) — empty and broken must look different.\n\n" +
    problems.map((p) => "  " + p).join("\n") + "\n",
  );
  process.exit(1);
}
console.log(`✓ C17 error branch: every query-driven \`?? []\` has an error branch (${Object.keys(EXCEPTIONS).length} exceptions, each with its reason)`);
