/**
 * The error paths themselves — the part of every route nobody looks at until it fires.
 *
 * `bad-input.test.ts` pins that malformed input does not produce a 500. This pins what a 500 LOOKS
 * like when one happens anyway, because that shape is a contract with two readers:
 *   · the client's `errText()` unwraps `{ error, detail }` into a sentence — a bare 500 or HTML was
 *     «[object Object]» on screen, the bug the JSON contract was written to end;
 *   · the raw cause (SQL, table names, paths) is for the OWNER only since registration opened
 *     (2026-09-17); everyone else gets `internal_error` and a `ref` that is also in the log line.
 *
 * ⚠️ `errText()` itself is client code and is not loadable here (its dictionaries are JSON imports
 * the node test runner refuses); its half of the contract is the shape pinned below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { errorBody } from "../lib/platform/error-body.ts";
import { userApp } from "../user-app.ts";
import { migratedDb, testEnv } from "./harness.ts";

test("errorBody: the owner sees the raw cause; a stranger sees only a reference", () => {
  const boom = new Error("no such column: t.secret_col");
  const own = errorBody(boom, "GET", "/api/summary", true);
  assert.equal(own.body.error, "no such column: t.secret_col");
  assert.ok(own.body.detail.includes("GET /api/summary"));
  assert.ok(own.body.detail.includes(own.ref), "the ref on screen is the ref in the log");

  const stranger = errorBody(boom, "GET", "/api/summary", false);
  assert.equal(stranger.body.error, "internal_error");
  assert.equal(stranger.body.detail, `ref ${stranger.ref}`);
  assert.ok(!JSON.stringify(stranger.body).includes("secret_col"), "no schema leaks to a stranger");
  assert.equal(stranger.msg, boom.message, "…while the log still gets the real message");
});

test("errorBody: a throw that is not an Error, or has no message, still yields the contract", () => {
  assert.equal(errorBody("plain string", "POST", "/x", true).body.error, "plain string");
  assert.equal(errorBody(new Error(""), "POST", "/x", true).body.error, "internal_error");
  assert.equal(errorBody(undefined, "POST", "/x", false).body.error, "internal_error");
});

/** A database whose every statement throws — the uncaught-SQL-error case, end to end. */
function brokenEnv(isOwner: boolean) {
  const env = testEnv(migratedDb());
  env.DB = { prepare() { throw new Error("D1_ERROR: no such table: transactions"); }, batch() { throw new Error("x"); } };
  env.IS_OWNER = isOwner;
  return env;
}

test("an uncaught throw inside the user's object answers 500 JSON, never an empty body", async (t) => {
  // The handler logs the cause on purpose; here that log is the expected output, not noise to read.
  t.mock.method(console, "error", () => {});
  for (const owner of [true, false]) {
    const res = await userApp.request("/api/summary", { method: "GET" }, brokenEnv(owner));
    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json() as { error: string; detail: string };
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.detail, "string");
    if (owner) assert.match(body.error, /no such table/);
    else assert.equal(body.error, "internal_error");
  }
});

test("an unknown path inside the object is a JSON 404 naming the path", async () => {
  const res = await userApp.request("/nowhere/at-all", { method: "GET" }, testEnv(migratedDb()));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found", detail: "/nowhere/at-all" });
});
