#!/usr/bin/env node
/**
 * C1 — the route layer does not talk to the database directly.
 *
 * The rule: `.prepare()` belongs in `worker/repo/`. A route parses the request, calls a
 * repository or a lib function, and serialises the answer.
 *
 * WHY THIS IS A CHECK AND NOT A CONVENTION
 *
 * Four of the most expensive bugs in this project (§CUR-PLAN, §SUB-MONTH, §REFUND, §SPLIT) share
 * one mechanism: a query lived inline in a handler, so nothing else could reuse it, so the next
 * feature wrote a second query that meant *almost* the same thing — and the two drifted silently,
 * because SQL is a string and `tsc` cannot see inside it. Moving the queries out only fixes it
 * once; this check is what keeps it fixed.
 *
 * WHY A BUDGET INSTEAD OF A FLAT BAN
 *
 * `api.ts` started with 179 inline queries. A flat ban would have to land as one enormous commit
 * — exactly the shape of change that hides a regression. So the ceiling ratchets: it may never
 * rise, and when it falls the budget must be lowered with it, which fails the build until it is.
 * That keeps the number honest instead of letting a stale allowance quietly permit new debt.
 *
 * A file absent from the budget is not allowed a single query.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES = "worker/routes";

/**
 * Remaining inline queries per route file. ONLY EVER GOES DOWN.
 * When you empty a file, delete its line — do not leave a `0`.
 */
const BUDGET = {
  "api.ts": 129,
  "import.ts": 3,
  "telegram.ts": 3,
  "setup.ts": 2,
  "webhook.ts": 2,
};

/** Count real call sites, ignoring comment lines so prose about `.prepare()` is not a violation. */
function countPrepares(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .reduce((n, l) => n + (l.match(/\.prepare\(/g)?.length ?? 0), 0);
}

const problems = [];
let total = 0;

for (const file of readdirSync(ROUTES).filter((f) => f.endsWith(".ts"))) {
  const actual = countPrepares(readFileSync(join(ROUTES, file), "utf8"));
  const allowed = BUDGET[file] ?? 0;
  total += actual;

  if (actual > allowed) {
    problems.push(
      `${ROUTES}/${file}: ${actual} inline queries, budget is ${allowed}.\n` +
      `    Move the new query into worker/repo/ instead of raising the budget.`,
    );
  } else if (actual < allowed) {
    problems.push(
      `${ROUTES}/${file}: down to ${actual} inline queries (budget still says ${allowed}).\n` +
      `    Lower it to ${actual} in scripts/check-repo-layer.mjs — the ratchet only works if it is tightened.`,
    );
  }
}

if (problems.length) {
  console.error("✗ C1 route layer:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}

const budgeted = Object.values(BUDGET).reduce((a, b) => a + b, 0);
console.log(
  budgeted === 0
    ? "✓ C1 route layer: no inline SQL in worker/routes"
    : `✓ C1 route layer: ${total} inline queries left to migrate (ceiling holds, never rises)`,
);
