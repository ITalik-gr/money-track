/**
 * §QUICK-ADD — a write-only phone token: signed user, generation and type (no other token opens this
 * door, this one opens no other), rows go through the canonical writer, and no double counts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  createQuickAddToken, verifyQuickAddToken, createMcpToken, verifyMcpToken, createSession, verifySession,
} from "../lib/platform/auth.ts";
import { quickAdd } from "../routes/quick-add.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";
import type { Env } from "../env.ts";

const USER_A = "aaaa1111bbbb2222";
const USER_B = "cccc3333dddd4444";
const KEYED = { SESSION_SECRET: "test-session-secret" } as never;

// ---- the credential ------------------------------------------------------------------------

test("quick-add token round-trips and cannot be re-pointed", async () => {
  const token = await createQuickAddToken(KEYED, USER_A, 3);
  assert.deepEqual(await verifyQuickAddToken(KEYED, token), { userId: USER_A, quickAddVersion: 3 });
  assert.equal(await verifyQuickAddToken(KEYED, token.replace(USER_A, USER_B)), null);
  assert.equal(await verifyQuickAddToken({ SESSION_SECRET: "other" } as never, token), null);
});

test("write-only: no other credential opens this door, and this one opens no other", async () => {
  const qa = await createQuickAddToken(KEYED, USER_A, 0);
  const mcp = await createMcpToken(KEYED, USER_A, 0);
  const session = await createSession(KEYED, USER_A, 0);
  assert.equal(await verifyQuickAddToken(KEYED, mcp), null);
  assert.equal(await verifyQuickAddToken(KEYED, session), null);
  assert.equal(await verifyMcpToken(KEYED, qa), null);
  assert.equal(await verifySession(KEYED, qa), null);
});

test("a demo sandbox cannot hold one", async () => {
  assert.equal(await verifyQuickAddToken(KEYED, await createQuickAddToken(KEYED, "demo:abc", 1)), null);
});

// ---- parsing ---------------------------------------------------------------------------------

// ---- the scenario ------------------------------------------------------------------------------

function app(m: MemDb) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/quick-add", quickAdd);
  const env = testEnv(m) as unknown as Env;
  return async (body: unknown) => {
    const r = await a.request("/quick-add", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, env);
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };
}

function db(): MemDb {
  const m = migratedDb();
  seed(m);
  for (const t of ["tx_splits", "tx_reimbursements", "ai_changes", "transactions"]) m.raw.prepare(`DELETE FROM ${t}`).run();
  return m;
}
const rows = (m: MemDb) => m.raw.prepare("SELECT id, source, amount, merchant, account_id, currency_code FROM transactions").all() as
  { id: string; source: string; amount: number; merchant: string | null; account_id: string; currency_code: number }[];

test("a Wallet payment lands as a spend through the canonical writer", async () => {
  const m = db();
  const post = app(m);
  const r = await post({ amount: "₴181.00", merchant: "Bolt", card: "Невідома картка" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "added");
  const [row] = rows(m);
  assert.equal(row!.source, "shortcut");
  assert.equal(row!.amount, -18100);
  assert.equal(row!.merchant, "Bolt");
  assert.equal(row!.currency_code, 980);
});

test("a card the bank already syncs is refused, not doubled", async () => {
  const m = db();
  // «Картка ₴» is the seeded monobank account (is_manual = 0).
  const r = await app(m)({ amount: "181", merchant: "Bolt", card: "Картка ₴" });
  assert.equal(r.json.status, "synced");
  assert.equal(rows(m).length, 0);
});

test("a bank row already there, or the automation firing twice, is one operation", async () => {
  const m = db();
  const now = Math.floor(Date.now() / 1000);
  m.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, hold, is_transfer, created_at)
     VALUES ('bank1', 'acc-uah', 'mono', ?, -18100, 980, 'Bolt', 0, 0, 0)`,
  ).run(now - 60);
  const post = app(m);
  assert.equal((await post({ amount: "181", merchant: "Bolt" })).json.status, "duplicate");

  assert.equal((await post({ amount: "99", merchant: "Кава" })).json.status, "added");
  assert.equal((await post({ amount: "99", merchant: "Кава" })).json.status, "duplicate");
  assert.equal(rows(m).length, 2);
});

// ---- perimeter pass (2026-09-17) — the neighbouring doors -------------------------------------

test("the OAuth consent page cannot be framed, while the app still can by Telegram", async () => {
  const { cspForFormTarget, CSP } = await import("../lib/platform/security-headers.ts");
  assert.match(cspForFormTarget("https://money.example", "https://claude.ai/cb"), /frame-ancestors 'none'/);
  assert.match(CSP, /frame-ancestors 'self' https:\/\/web\.telegram\.org/);
});
