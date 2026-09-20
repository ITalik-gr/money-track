/**
 * §FOP-GATE — the ФОП module answers the owner and nobody else, while it is unfinished.
 *
 * Hidden on the owner's call (2026-09-20: «ФОП там ще і близько поки не так як я планував»), so
 * this is a product decision with an expiry, not a permission model. It is pinned by a test
 * anyway, and pinned as a CLASS: the gate is one middleware over `/tax/*`, and the failure it
 * exists to catch is the twentieth route being mounted outside the prefix — which a list of
 * nineteen hand-written paths would not notice.
 *
 * The list below is therefore READ FROM THE ROUTER, not typed out: a route added tomorrow is
 * tested tomorrow, or this test fails because the two disagree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tax } from "../routes/api/tax.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";
import { seed, seedRareTables, FROZEN_NOW_ISO } from "./fixture.ts";
import { fopAvailable } from "../lib/finance/tax.ts";

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
