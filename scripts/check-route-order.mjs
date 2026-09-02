#!/usr/bin/env node
/**
 * C7 — a literal route is never registered BELOW a parameterised one that already matches it.
 *
 * WHY THIS IS A CHECK AND NOT A CONVENTION
 *
 * Hono matches in registration order, so `GET /transactions/:id` declared above
 * `GET /transactions/frequent` makes the literal unreachable — every request for it lands in the
 * `:id` handler, which looks up a transaction with the id "frequent", finds none, and answers 404.
 * That is a real outage this project has already had, and it is invisible in review: both routes
 * exist, both look right, and nothing fails at build time.
 *
 * It became worth automating when `api.ts` was split into `routes/api/<domain>.ts` (2026-08-07).
 * The split's whole claim is "one file owns a whole path prefix, so ordering is checkable by
 * reading ONE file". This makes that claim mechanical instead of a habit — and it also catches
 * the case the split cannot: a prefix accidentally served by two files, where the order that
 * decides the winner is the MOUNT order in `index.ts` rather than anything visible at the routes.
 *
 * Deliberately conservative: it only reports a literal fully covered by an earlier parameterised
 * route of the same method and segment count. A `*` wildcard route counts as parameterised.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["worker/routes", "worker/routes/api"];

// The app object a route is hung on. Matching a NAME rather than any `.get(` keeps `c.get("locale")`
// — a context read, not a route — from being parsed as `GET /locale`.
const APP_NAMES = /^(api|app|setup|ingest|credentials|importRoutes|webhook|telegram|admin|account|auth|analytics|accounts|advisor|budgets|categories|events|exportRoutes|goals|insights|jobs|knowledge|notifications|planned|reports|settings|transactions|transfers)$/;
const ROUTE = /^\s*(\w+)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/;

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(dir, e.name));
}

const problems = [];
const prefixOwners = new Map();

for (const file of DIRS.flatMap(tsFiles)) {
  const routes = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const m = line.match(ROUTE);
    if (!m || !APP_NAMES.test(m[1])) return;
    routes.push({ method: m[2].toUpperCase(), path: m[3], line: i + 1 });
  });

  for (const r of routes) {
    const seg = r.path.split("/").filter(Boolean)[0];
    if (!seg || seg.startsWith(":") || seg === "*") continue;
    if (!prefixOwners.has(seg)) prefixOwners.set(seg, new Set());
    prefixOwners.get(seg).add(file);
  }

  for (let i = 0; i < routes.length; i++) {
    const a = routes[i];
    const as = a.path.split("/").filter(Boolean);
    const dynamic = (s) => s.startsWith(":") || s === "*";
    if (!as.some(dynamic)) continue;
    for (let j = i + 1; j < routes.length; j++) {
      const b = routes[j];
      if (a.method !== "ALL" && a.method !== b.method) continue;
      const bs = b.path.split("/").filter(Boolean);
      if (as.length !== bs.length || bs.some(dynamic)) continue;
      if (as.every((s, k) => dynamic(s) || s === bs[k])) {
        problems.push(
          `${file}:${b.line}  ${b.method} ${b.path} is UNREACHABLE — ` +
          `${a.method} ${a.path} (line ${a.line}) matches it first.\n` +
          `    Move the literal route above the parameterised one.`,
        );
      }
    }
  }
}

for (const [seg, files] of prefixOwners) {
  if (files.size > 1) {
    problems.push(
      `/${seg} is served by ${files.size} files: ${[...files].join(", ")}.\n` +
      `    One file owns one prefix — otherwise which handler wins depends on mount order.`,
    );
  }
}

if (problems.length) {
  console.error("✗ C7 route order:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}
console.log("✓ C7 route order: no literal route shadowed by a parameterised one");
