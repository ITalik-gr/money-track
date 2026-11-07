#!/usr/bin/env node
/**
 * C24 — the client imports React Router from ONE package: `react-router-dom`.
 *
 * `react-router-dom` is the declared dependency and the app's `RouterProvider` comes from it.
 * A bare `from "react-router"` resolves to whatever copy sits at the top of `node_modules` — on
 * 2026-11-07 that was an extraneous 7.18.1 beside the 7.18.4 `react-router-dom` bundles. Two
 * copies mean two React contexts: a hook from the other copy cannot see the router, and Settings
 * died in production with «useLocation() may be used only in the context of a <Router>». Five
 * files had the bare import; which pages broke depended on what the installer left lying around.
 *
 * Every import / export-from / dynamic import of the bare specifier fails the check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = process.argv.slice(2).length ? process.argv.slice(2) : ["src", "shared"];
const BAD = /(?:from\s*|import\s*\(\s*)["']react-router["']/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") yield* files(p); }
    else if (/\.(tsx?|jsx?|mjs)$/.test(p)) yield p;
  }
}

const hits = [];
for (const root of ROOTS) {
  for (const f of files(root)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (BAD.test(line)) hits.push(`  ${f}:${i + 1}  ${line.trim()}`);
    });
  }
}

if (hits.length) {
  console.error(`✗ C24 router import: import from "react-router-dom", never the bare "react-router" —\n` +
    `  a second copy of the package is a second router context, and its hooks throw.\n\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("✓ C24 router import: every React Router import comes from react-router-dom");
