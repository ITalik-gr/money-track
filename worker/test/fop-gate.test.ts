/**
 * §FOP-GATE — the unfinished ФОП module answers the owner only. The route list is read from the
 * router, so a route mounted tomorrow is tested tomorrow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tax } from "../routes/api/tax.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";
import { seed, seedRareTables, FROZEN_NOW_ISO } from "./fixture.ts";
import { fopAvailable } from "../lib/finance/tax.ts";
import { mcp } from "../routes/mcp.ts";

/** Every path the ФОП surface declares, with its method — taken from the Hono instance itself. */
function declaredRoutes(): { method: string; path: string }[] {
  return tax.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => ({ method: r.method, path: r.path }));
}

/** A concrete URL for a declared path: parameters filled with an id that need not exist. */
const concrete = (path: string) => path.replace(/:[^/]+/g, "1");

test("§FOP-GATE: the whole /tax/* surface is 404 for a non-owner", async (t) => {
  t.after(freezeTime(FROZEN_NOW_ISO));
  const db = migratedDb();
  seed(db);
  seedRareTables(db);
  const env = { ...testEnv(db), IS_OWNER: false };

  const routes = declaredRoutes();
  // A sanity floor: if the router ever comes back empty, the loop below would pass vacuously.
  assert.ok(routes.length >= 15, `expected the ФОП surface, got ${routes.length} routes`);

  for (const { method, path } of routes) {
    const res = await tax.request(concrete(path), {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
    }, env);
    assert.equal(res.status, 404, `${method} ${path} answered ${res.status}, not 404`);
  }
});

test("§FOP-GATE: the owner still reaches the module", async (t) => {
  t.after(freezeTime(FROZEN_NOW_ISO));
  const db = migratedDb();
  seed(db);
  seedRareTables(db);

  const res = await tax.request("/tax/status", {}, testEnv(db));
  assert.equal(res.status, 200);
  const body = await res.json() as { enabled: boolean };
  // Not «enabled»: the owner's profile in a fresh database is off. The claim is that he gets an
  // ANSWER — the gate is about reach, not about whether he has filled the module in.
  assert.equal(typeof body.enabled, "boolean");
});

test("§FOP-GATE: a demo session is not the owner", () => {
  // The demo sandbox carries no owner flag, so it falls on the hidden side without a rule of its
  // own — which is the point of gating on the env rather than on a stored preference.
  assert.equal(fopAvailable({}), false);
  assert.equal(fopAvailable({ IS_OWNER: false }), false);
  assert.equal(fopAvailable({ IS_OWNER: true }), true);
});

test("§FOP-GATE: the MCP server does not describe the ФОП tool to a non-owner's assistant", async (t) => {
  t.after(freezeTime(FROZEN_NOW_ISO));
  const db = migratedDb();
  seed(db);
  const init = async (env: Record<string, unknown>) => {
    const res = await mcp.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }, env);
    return ((await res.json()) as { result: { instructions: string } }).result.instructions;
  };
  const stranger = await init({ ...testEnv(db), IS_OWNER: false });
  assert.doesNotMatch(stranger, /ФОП|get_tax_status/);
  // The rest of the guidance is still there — the gate removes one paragraph, not the manual.
  assert.match(stranger, /get_finance_snapshot/);
  assert.match(stranger, /WHOLE CURRENCY UNITS/);
  assert.match(await init(testEnv(db)), /get_tax_status/);
});
