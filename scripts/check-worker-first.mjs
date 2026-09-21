#!/usr/bin/env node
/**
 * C13 — every worker route outside `/api/*` is listed in `assets.run_worker_first`.
 *
 * WHAT GOES WRONG WITHOUT IT (docs/OPS.md, and the comments inside `wrangler.jsonc` are three
 * separate accounts of the same afternoon): Cloudflare's static-asset router answers first. A path
 * the worker handles but the asset config does not name is served the SPA shell — a 200 with HTML
 * in it. Nothing errors. The symptoms are «the MCP client says the server returned invalid JSON»,
 * «the bank's webhook gets a 200 and we never see the operation», «a shared photo vanishes with a
 * 405» — none of which sound like a routing config, which is why this costs an afternoon every
 * time instead of a minute.
 *
 * The rule is already written in `CLAUDE.md`'s hard invariants. It was held by memory: adding a
 * route is a one-line edit in `index.ts`, and nothing anywhere connected it to a JSON file.
 *
 * ⚠️ `/api/*` is not checked — it is the one prefix that has been in the list since the beginning
 * and is the shape every new endpoint takes anyway.
 */
import { readFileSync } from "node:fs";

const INDEX = "worker/index.ts";
const CONFIG = "wrangler.jsonc";

/** Sub-apps mounted at `/` — their own files carry the paths, so they are scanned too. */
const MOUNTED_AT_ROOT = ["worker/routes/wellknown.ts", "worker/routes/oauth.ts"];

/**
 * `app.get("/x"…)`, `app.all("/x/*"…)`, `app.route("/x", sub)`.
 *
 * ⚠️ Plain quotes only, and no newline inside. A backtick alternative matched a multi-line
 * template literal further down the file and reported half a function body as a route — a lint
 * that cries wolf is worse than none (the C9 lesson). A Hono path is always a plain string.
 */
const ROUTE_RE = /\bapp\.(?:get|post|put|patch|delete|all|route|use)\s*\(\s*["']([^"'\n]+)["']/g;
/** Inside a sub-app the instance has another name (`wellKnown.get(...)`). */
const SUB_RE = /\b[A-Za-z_$][\w$]*\.(?:get|post|put|patch|delete|all|use)\s*\(\s*["'](\/[^"'\n]*)["']/g;

function paths(file, re) {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...src.matchAll(re)].map((m) => m[1]).filter((p) => p.startsWith("/"));
}

/** The list, with comments stripped — JSONC is not JSON. */
function workerFirst() {
  const raw = readFileSync(CONFIG, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const block = /"run_worker_first"\s*:\s*\[([\s\S]*?)\]/.exec(raw);
  if (!block) throw new Error(`${CONFIG}: no run_worker_first array`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Does `pattern` cover `route`? A `:param` in the route is any single segment, and a trailing `*`
 * in the pattern covers everything below it — which is exactly how Cloudflare reads both.
 */
function covers(pattern, route) {
  if (pattern.endsWith("/*")) return route === pattern.slice(0, -2) || route.startsWith(pattern.slice(0, -1));
  return pattern === route.replace(/\/:[^/]+/g, (m) => m); // exact match, params included verbatim
}

const listed = workerFirst();
const routes = new Set([
  ...paths(INDEX, ROUTE_RE),
  ...MOUNTED_AT_ROOT.flatMap((f) => paths(f, SUB_RE)),
]);

const problems = [];
for (const route of [...routes].sort()) {
  if (route === "/" || route.startsWith("/api")) continue;
  // A route with a parameter is covered by the prefix above it (`/webhook/:token` ← `/webhook/*`).
  const probe = route.replace(/\/:[^/]+/g, "/x");
  if (!listed.some((p) => covers(p, probe))) {
    problems.push(
      `${INDEX}: route "${route}" is not covered by assets.run_worker_first.\n` +
      `    Cloudflare's asset router answers first, so this path would be served the SPA SHELL —\n` +
      `    a 200 with HTML in it, and no error anywhere. Add "${route.replace(/\/:[^/]+.*/, "/*")}"\n` +
      `    to the list in ${CONFIG} (CLAUDE.md, Hard invariants).`,
    );
  }
}

if (problems.length) {
  console.error("✗ C13 run_worker_first:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}
console.log(`✓ C13 run_worker_first: ${routes.size} worker routes, every non-/api one is listed`);
