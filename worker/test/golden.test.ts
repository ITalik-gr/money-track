/**
 * Characterization ("golden") tests for the read-only API surface.
 *
 * These do NOT assert that the numbers are correct. They assert that the numbers are the SAME as
 * before — which is the only question a behaviour-preserving refactor is allowed to ask. The
 * structural work this guards (pulling ~179 raw queries out of the route layer into a repository,
 * then splitting the routes by domain) touches money math that four separate production bugs have
 * already proved is easy to break silently. `tsc` cannot see into a SQL string; the SQL linter
 * only checks that a query mentioning the canon also carries STATS_JOINS. Nothing until now
 * checked what the endpoints actually return.
 *
 * Recording a new baseline (only ever with a deliberate, reviewed behaviour change):
 *
 *     UPDATE_GOLDEN=1 npm test
 *
 * A diff here means one of two things, and telling them apart is the entire job: either the
 * refactor changed a number (a regression — revert it), or a behaviour change was intended (say
 * so, then re-record). Never re-record to make a red test green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "__golden__");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

/**
 * The read-only surface, with the query strings the UI actually sends. Presets are included
 * explicitly where an endpoint takes one: a period bug that only shows on `quarter` is exactly
 * the kind this suite exists to catch, and the default alone would not exercise it.
 */
const ENDPOINTS: string[] = [
  "/summary",
  "/accounts",
  "/accounts/funds",
  "/accounts/history",
  "/categories",
  "/rates",
  "/transactions?limit=50",
  "/transactions/frequent",
  "/budgets",
  "/budgets/auto",
  "/budgets/auto?trim=25",
  "/planned",
  "/planned/upcoming",
  "/planned/actuals",
  "/planned/detect",
  "/reports",
  "/goals",
  "/events",
  "/analytics/overview",
  "/analytics/overview?preset=week",
  "/analytics/overview?preset=quarter",
  "/analytics/overview?preset=year",
  "/analytics/monthly-history",
  "/analytics/safe-to-spend",
  "/analytics/capital-trend",
  "/analytics/networth",
  "/analytics/compare",
  "/analytics/forecast",
  "/analytics/income",
  "/analytics/cashflow-calendar",
  "/analytics/receipt-items",
  "/analytics/price-drift",
  "/analytics/patterns",
  "/analytics/currencies",
  "/analytics/by-category",
  "/analytics/spark",
  "/analytics/health",
  "/analytics/category?id=1",
  "/analytics/merchant?name=Сільпо",
];

/** Filename-safe slug of the request path, so a golden file is traceable to its endpoint. */
function slug(path: string): string {
  return path.replace(/^\//, "").replace(/[?=&]/g, "_").replace(/\//g, ".") || "root";
}

function fixture(): MemDb {
  const db = migratedDb();
  seed(db);
  return db;
}

test("golden: read-only API responses are unchanged", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
    // One database for the whole sweep: these endpoints are reads, and a shared fixture makes
    // cross-endpoint disagreement (the actual bug class here) visible in one run.
    const env = testEnv(fixture());

    for (const path of ENDPOINTS) {
      await t.test(path, async () => {
        const res = await api.request(path, {}, env);
        const body = await res.text();
        assert.equal(res.status, 200, `${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);

        const actual = JSON.stringify({ status: res.status, body: JSON.parse(body) }, null, 2);
        const file = join(GOLDEN_DIR, `${slug(path)}.json`);

        if (UPDATE || !existsSync(file)) {
          writeFileSync(file, actual + "\n");
          // A freshly recorded file proves nothing, so say so rather than reporting a pass.
          t.diagnostic(`recorded baseline: ${slug(path)}.json`);
          return;
        }
        assert.equal(actual, readFileSync(file, "utf8").trimEnd(),
          `${path} changed. Either the refactor broke it, or the change was intended — ` +
          `if intended, re-record with UPDATE_GOLDEN=1.`);
      });
    }
  } finally {
    restore();
  }
});
