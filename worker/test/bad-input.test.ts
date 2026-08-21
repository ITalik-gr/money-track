/**
 * Garbage in a query string must not become a 500 — or, worse, a plausible zero.
 *
 * Found on 2026-08-21 by a security-shaped pass over the endpoints added that night. Two of them
 * answered `500` to `?months=abc`, and two more answered `200` with `{from: null, spend: 0}`,
 * which reads on screen as «нічого не витрачено».
 *
 * The cause is one idiom used thirty-one times across the analytics surface:
 * `Number(url.searchParams.get(x) ?? d)`. `??` catches null and undefined; it does not catch
 * `NaN`, and `Number("abc")` IS a value. So the fallback never fires and the NaN travels — into
 * `localMonthStart`, where it throws, or into a bind, where it quietly matches nothing.
 *
 * ⚠️ The endpoints below are the ones a stale bookmark or a hand-edited URL actually reaches. The
 * assertion is deliberately weak — «not 500, and the window is real» — because the point is the
 * CLASS, not any one endpoint's numbers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";
import { seed, seedRareTables, FROZEN_NOW_ISO } from "./fixture.ts";
import { numParam } from "../routes/api/_shared.ts";

const GARBAGE = [
  "/analytics/fx-cost?from=abc&to=xyz",
  "/analytics/day-of-month?from=abc&to=xyz",
  "/analytics/compare?from=abc&to=abc",
  "/analytics/overview?from=NaN&to=NaN",
  "/analytics/weekday?from=&to=",
  "/budgets/history?months=abc",
  "/budgets/history?months=-5",
  "/budgets/history?months=999",
  "/analytics/slice?dim=day&value=x&from=abc&to=abc",
];

test("no endpoint answers 500 to a malformed query string", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    seedRareTables(db);
    const env = testEnv(db);
    for (const path of GARBAGE) {
      await t.test(path, async () => {
        const res = await api.request(path, {}, env);
        assert.ok(res.status < 500, `${path} answered ${res.status}`);
        const body = await res.text();
        // And not a NaN window dressed as an answer: `from: null` is how the quiet variant looks.
        assert.ok(!body.includes('"from":null'), `${path} returned a null window`);
        assert.ok(!body.includes("NaN"), `${path} leaked a NaN into the response`);
      });
    }
  } finally { restore(); }
});

test("numParam clamps rather than rejecting, and never yields NaN", () => {
  const u = (q: string) => new URL(`https://x/?${q}`);
  assert.equal(numParam(u("m=7"), "m", 12), 7);
  assert.equal(numParam(u("m=abc"), "m", 12), 12, "the fallback fires for a non-number");
  assert.equal(numParam(u(""), "m", 12), 12, "and for an absent one");
  assert.equal(numParam(u("m="), "m", 12), 12, "and for an empty one — `Number('')` is 0, not NaN");
  assert.equal(numParam(u("m=Infinity"), "m", 12), 12, "Infinity is not finite either");
  // Clamped, not refused: these are window bounds off a URL, and a stale link should show the
  // default view rather than an error page.
  assert.equal(numParam(u("m=-5"), "m", 12, { min: 1, max: 24 }), 1);
  assert.equal(numParam(u("m=999"), "m", 12, { min: 1, max: 24 }), 24);
});
