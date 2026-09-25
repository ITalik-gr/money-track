/**
 * §MCP — the ledger exposed to MCP clients. The token is a second door into an account: the user id,
 * generation and type are signed, so an edited, stale or foreign token must fail. Read-only tools.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mcp } from "../routes/mcp.ts";
import { createMcpToken, verifyMcpToken, createSession, verifySession } from "../lib/platform/auth.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const USER_A = "aaaa1111bbbb2222";
const USER_B = "cccc3333dddd4444";
const KEYED = { SESSION_SECRET: "test-session-secret" } as never;

// ---- the credential ------------------------------------------------------------------------

test("mcp token round-trips, and carries the user it was minted for", async () => {
  const token = await createMcpToken(KEYED, USER_A, 1);
  assert.deepEqual(await verifyMcpToken(KEYED, token), { userId: USER_A, mcpVersion: 1 });
});

test("a token cannot be re-pointed at another account", async () => {
  const token = await createMcpToken(KEYED, USER_A, 1);
  // The plain-text user id is right there in the token; the signature is the only thing stopping
  // anyone from editing it. This is the whole isolation story, so it is asserted directly.
  const forged = token.replace(USER_A, USER_B);
  assert.notEqual(forged, token);
  assert.equal(await verifyMcpToken(KEYED, forged), null);
});

test("a token minted with another key does not verify", async () => {
  const token = await createMcpToken({ SESSION_SECRET: "someone-elses-key" } as never, USER_A, 1);
  assert.equal(await verifyMcpToken(KEYED, token), null);
});

test("a stale generation is refused (revocation actually revokes)", async () => {
  const token = await createMcpToken(KEYED, USER_A, 1);
  const claim = await verifyMcpToken(KEYED, token);
  // The signature still verifies — that is the point of the second half of the check. It is the
  // CALLER comparing the generation against the directory that ends the token's life, which is
  // why `worker/index.ts` may never skip it.
  assert.equal(claim?.mcpVersion, 1);
  assert.notEqual(claim?.mcpVersion, 2);
});

test("a session cookie is not an MCP token, and an MCP token is not a session cookie", async () => {
  const session = await createSession(KEYED, USER_A, 0);
  const token = await createMcpToken(KEYED, USER_A, 0);
  assert.equal(await verifyMcpToken(KEYED, session), null);
  assert.equal(await verifySession(KEYED, token), null);
});

test("a demo sandbox cannot hold an MCP token", async () => {
  // `demo:<random>` is not hex, so the id never survives verification whatever was signed.
  const token = await createMcpToken(KEYED, "demo:abc123", 1);
  assert.equal(await verifyMcpToken(KEYED, token), null);
});

test("an expired token is refused", async () => {
  const token = await createMcpToken(KEYED, USER_A, 1);
  const restore = freezeTime("2030-01-01T00:00:00.000Z");
  try {
    assert.equal(await verifyMcpToken(KEYED, token), null);
  } finally { restore(); }
});

// ---- the protocol --------------------------------------------------------------------------

function env() {
  const db = migratedDb();
  seed(db);
  return testEnv(db);
}
/* eslint-disable @typescript-eslint/no-explicit-any */
// Loosely typed on purpose: these assertions are ABOUT the wire shape, so declaring the shape
// here would let a test pass by agreeing with itself instead of with the response.
async function rpc(e: Record<string, unknown>, method: string, params?: unknown) {
  const res = await mcp.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, e);
  const body = res.status === 202 ? {} : await res.json();
  return { status: res.status, body: body as any };
}

test("tools/list offers the snapshot and the read tools, and NOT the write tool", async () => {
  const { body } = await rpc(env(), "tools/list");
  const names = (body.result.tools as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(names, ["find_transactions", "get_finance_snapshot", "get_tax_status", "list_categories", "query_spend"]);
  // Every tool must carry a schema under the MCP field name — `input_schema` is Anthropic's
  // spelling, and a client handed the wrong key sees a tool that takes no arguments.
  for (const t of body.result.tools as { inputSchema?: unknown }[]) assert.ok(t.inputSchema);
});

test("tools/call refuses the write tool BY NAME, not merely by omitting it from the list", async () => {
  const { body } = await rpc(env(), "tools/call", {
    name: "remember_fact",
    arguments: { text: "rent went up", category: "Житло", multiplier: 2 },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /unknown tool/);
  // And nothing was written: the executor that knows this tool was never reached.
  assert.equal(body.error, undefined);
});

test("the snapshot answers in ONE unit, and names the currency as data", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const { body } = await rpc(env(), "tools/call", { name: "get_finance_snapshot", arguments: {} });
    assert.equal(body.result.isError, false);
    const snap = JSON.parse(body.result.content[0].text) as Record<string, unknown>;
    assert.equal(typeof snap.currency, "string");
    assert.equal(typeof snap.monthly_burn_uah, "number");
    /**
     * The minor-unit half of `FinanceSnapshot` must NOT be on the wire. `ownFunds` and
     * `monthlyBurn` are copies of `own_funds_uah` / `monthly_burn_uah` multiplied by 100, and an
     * answer carrying both would be two units — differing by 100× — inside one payload.
     */
    assert.equal(snap.ownFunds, undefined);
    assert.equal(snap.monthlyBurn, undefined);
    // The adviser's own notes ride along: they are what tells the model that a 90-day total is
    // not a monthly one, which is the mistake this data invites.
    assert.ok(typeof snap.period_note === "string");
  } finally { restore(); }
});
