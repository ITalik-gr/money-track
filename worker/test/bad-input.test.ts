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
  // Added by the A2 audit (2026-09-18) with the ФОП surface: same idiom, same stale-bookmark risk.
  "/tax/ledger?from=abc&to=xyz",
  "/tax/ledger.csv?from=abc&to=xyz",
  "/tax/business?quarters=abc",
  "/tax/business?quarters=-5",
  "/tax/business?quarters=999",
];

/**
 * A WRITE whose id names no row must not answer success.
 *
 * The other half of the same defect, and the worse half. `Number(c.req.param("id"))` is `NaN` for
 * `/abc`; NaN binds as NULL, the UPDATE matches nothing, and the handler returns 200 — `{ok:true}`
 * for a delete that deleted nothing, and a whole tax status for a «paid» that marked nothing paid.
 * A 500 gets retried and reported; a silent success is believed. The same holds for a well-formed
 * id that simply does not exist, which is what a stale client list produces.
 */
const SILENT_WRITES: [string, string][] = [
  // The 2026-09-18 sweep: thirty-five call sites across ten files used to build a path id with a
  // bare `Number(…)`. One per family here rather than one per route — the CLASS is the point, and
  // lint C7 now refuses the idiom outright, so this list is the behavioural half of the same rule.
  ["PATCH", "/goals/abc"],
  ["DELETE", "/goals/abc"],
  ["POST", "/goals/abc/contributions"],
  ["PATCH", "/events/abc"],
  ["DELETE", "/events/abc"],
  ["DELETE", "/events/1/planned/abc"],
  ["PATCH", "/categories/abc"],
  ["DELETE", "/categories/abc"],
  ["PATCH", "/planned/abc"],
  ["DELETE", "/planned/abc"],
  ["PATCH", "/rules/abc"],
  ["DELETE", "/rules/abc"],
  ["PUT", "/budgets/abc"],
  ["POST", "/advisor/facts/abc/confirm"],
  ["DELETE", "/advisor/facts/abc"],
  ["POST", "/jobs/abc/seen"],
  ["POST", "/tax/obligations/abc/paid"],
  ["POST", "/tax/obligations/0/paid"],
  ["POST", "/tax/obligations/999999/paid"],
  ["POST", "/tax/watch/sources/abc/unmute"],
  ["DELETE", "/tax/watch/sources/abc"],
  ["POST", "/tax/transactions/no-such-tx/business"],
  ["POST", "/tax/accounts/no-such-account/business"],
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

test("a write against an id that names no row is refused, not reported as done", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    seedRareTables(db);
    const env = testEnv(db);
    for (const [method, path] of SILENT_WRITES) {
      await t.test(`${method} ${path}`, async () => {
        const res = await api.request(
          path,
          { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ business: 1 }) },
          env,
        );
        assert.ok(res.status >= 400 && res.status < 500, `${path} answered ${res.status}`);
        // Weak on purpose, like the test above: the CLASS is «a write that changed nothing does not
        // claim it did», not any one endpoint's status code or wording.
        const body = await res.text();
        assert.ok(!body.includes('"ok":true'), `${path} reported success`);
      });
    }
  } finally { restore(); }
});
