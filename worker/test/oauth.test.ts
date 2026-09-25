/**
 * §MCP-OAUTH — the authorization server tested from the attacker's side: redirect matching, PKCE,
 * audience binding, single-use codes and refresh rotation. Mostly refusals — code a refactor can
 * quietly delete while a legitimate client keeps working.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { oauth } from "../routes/oauth.ts";
import { migratedDirectoryDb, type MemDb } from "./harness.ts";
import { createSession, createMcpToken } from "../lib/platform/auth.ts";
import { inviteUser, setUserStatus } from "../lib/platform/directory.ts";
import {
  redirectAllowed, redirectUriUsable, pkceVerifies,
  createAccessToken, verifyAccessToken, sha256Hex,
} from "../lib/platform/oauth.ts";
import { issueCode, redeemCode, createGrant, rotateGrant, deleteUserGrants } from "../lib/platform/oauth-store.ts";

const KEY = "test-session-secret";
const RESOURCE = "https://money.example/mcp";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function env(dir: MemDb) {
  return { DIRECTORY: dir, SESSION_SECRET: KEY } as unknown as Record<string, unknown>;
}

// ---- redirect matching: the open-redirect surface ------------------------------------------

test("a redirect URI must match a registered one exactly", () => {
  const reg = [CLAUDE_CB];
  assert.equal(redirectAllowed(CLAUDE_CB, reg), true);
  assert.equal(redirectAllowed("https://evil.example/api/mcp/auth_callback", reg), false);
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback/extra", reg), false);
  // A registered PREFIX is not a registered URI: `claude.ai.evil.example` contains the host.
  assert.equal(redirectAllowed("https://claude.ai.evil.example/api/mcp/auth_callback", reg), false);
});

test("loopback ignores the port — and ONLY loopback does", () => {
  // RFC 8252 §7.3, and Claude Code depends on it: it binds an ephemeral port per session, so a
  // byte-exact comparison would refuse every Claude Code connection while looking correct.
  assert.equal(redirectAllowed("http://localhost:53119/callback", ["http://localhost/callback"]), true);
  assert.equal(redirectAllowed("http://127.0.0.1:8081/callback", ["http://127.0.0.1/callback"]), true);
  // The exemption is the port and nothing else.
  assert.equal(redirectAllowed("http://localhost:53119/other", ["http://localhost/callback"]), false);
  assert.equal(redirectAllowed("https://claude.ai:8443/api/mcp/auth_callback", [CLAUDE_CB]), false);
});

test("only HTTPS, or loopback over HTTP, may be registered at all", () => {
  assert.equal(redirectUriUsable(CLAUDE_CB), true);
  assert.equal(redirectUriUsable("http://localhost/callback"), true);
  // Plain HTTP to a remote host puts the code on the wire in clear text.
  assert.equal(redirectUriUsable("http://evil.example/cb"), false);
  assert.equal(redirectUriUsable("https://ok.example/cb#frag"), false);
  assert.equal(redirectUriUsable("not-a-url"), false);
});

// ---- audience and PKCE ----------------------------------------------------------------------

test("PKCE accepts only the S256 preimage, never the challenge itself", async () => {
  const verifier = "a".repeat(64);
  const challenge = (await import("node:crypto")).createHash("sha256").update(verifier)
    .digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(await pkceVerifies(verifier, challenge), true);
  assert.equal(await pkceVerifies("b".repeat(64), challenge), false);
  // `plain` downgrade: presenting the challenge as the verifier must not work.
  assert.equal(await pkceVerifies(challenge, challenge), false);
  // Too short to carry 256 bits of entropy (RFC 7636 §4.1).
  assert.equal(await pkceVerifies("short", challenge), false);
});

test("an access token is bound to ONE audience", async () => {
  const e = { SESSION_SECRET: KEY } as never;
  const token = await createAccessToken(e, "aaaa11", 3, RESOURCE);
  assert.deepEqual(await verifyAccessToken(e, token, RESOURCE), { userId: "aaaa11", mcpVersion: 3 });
  /**
   * The same signing key, a different deployment. Without the audience tag this token would be
   * valid there — one leaked key would make every deployment of this codebase interchangeable,
   * which is exactly the "token passthrough" the MCP spec forbids.
   */
  assert.equal(await verifyAccessToken(e, token, "https://other.example/mcp"), null);
});

test("an access token cannot be re-pointed, and a personal token is not one", async () => {
  const e = { SESSION_SECRET: KEY } as never;
  const token = await createAccessToken(e, "aaaa11", 0, RESOURCE);
  assert.equal(await verifyAccessToken(e, token.replace("aaaa11", "bbbb22"), RESOURCE), null);
  // The two credential types are separated by a prefix that is INSIDE the signature.
  const personal = await createMcpToken(e, "aaaa11", 0);
  assert.equal(await verifyAccessToken(e, personal, RESOURCE), null);
});

// ---- single-use codes and rotating refresh tokens --------------------------------------------

const rec = (userId: string) => ({
  user_id: userId, client_id: "c1", redirect_uri: CLAUDE_CB,
  code_challenge: "x".repeat(43), resource: RESOURCE, scope: "mcp:read",
});

test("an authorization code can be redeemed exactly once", async () => {
  const dir = migratedDirectoryDb() as unknown as D1Database;
  const code = await issueCode(dir, rec("u1"));
  assert.equal((await redeemCode(dir, code))?.user_id, "u1");
  // Replay after a leak must lose, and losing must not depend on timing.
  assert.equal(await redeemCode(dir, code), null);
});

test("rotating a refresh token kills the one presented", async () => {
  const dir = migratedDirectoryDb() as unknown as D1Database;
  const { refreshToken } = await createGrant(dir, { user_id: "u1", client_id: "c1", scope: "mcp:read", resource: RESOURCE });
  const rotated = await rotateGrant(dir, refreshToken);
  assert.equal(rotated?.grant.user_id, "u1");
  assert.notEqual(rotated?.refreshToken, refreshToken);
  // OAuth 2.1 requires rotation for public clients; a window where both work is a window where a
  // stolen refresh token keeps its value.
  assert.equal(await rotateGrant(dir, refreshToken), null);
  assert.ok(await rotateGrant(dir, rotated!.refreshToken));
});

test("the refresh token is stored hashed, never in the clear", async () => {
  const dir = migratedDirectoryDb();
  const { refreshToken } = await createGrant(dir as unknown as D1Database, {
    user_id: "u1", client_id: "c1", scope: "mcp:read", resource: RESOURCE,
  });
  const row = dir.raw.prepare("SELECT refresh_hash FROM oauth_grants").get() as { refresh_hash: string };
  assert.notEqual(row.refresh_hash, refreshToken);
  assert.equal(row.refresh_hash, await sha256Hex(refreshToken));
});

test("revoking a user's grants ends every refresh token they handed out", async () => {
  const dir = migratedDirectoryDb() as unknown as D1Database;
  const { refreshToken } = await createGrant(dir, { user_id: "u1", client_id: "c1", scope: "mcp:read", resource: RESOURCE });
  await deleteUserGrants(dir, "u1");
  assert.equal(await rotateGrant(dir, refreshToken), null);
});

// ---- discovery ------------------------------------------------------------------------------

// ---- the flow -------------------------------------------------------------------------------

async function seedUser(dir: MemDb) {
  const user = await inviteUser(dir as unknown as D1Database, { email: "owner@example.com" });
  await setUserStatus(dir as unknown as D1Database, user.id, "active");
  return user;
}

async function register(dir: MemDb, uris = [CLAUDE_CB]) {
  const res = await oauth.request("http://money.example/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: uris }),
  }, env(dir));
  return (await res.json() as { client_id: string }).client_id;
}

function form(body: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

test("authorize refuses an unknown client WITHOUT redirecting", async () => {
  const dir = migratedDirectoryDb();
  const res = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=x&code_challenge_method=S256`,
    {}, env(dir));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
});

test("authorize refuses an UNREGISTERED redirect_uri without redirecting to it", async () => {
  const dir = migratedDirectoryDb();
  const clientId = await register(dir);
  const evil = "https://evil.example/steal";
  const res = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(evil)}&code_challenge=x&code_challenge_method=S256`,
    {}, env(dir));
  // The whole open-redirect defence: an unverified destination is never sent an answer of any
  // kind, not even an error.
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
});

test("authorize refuses PKCE-less and plain-PKCE requests, via the client's own redirect", async () => {
  const dir = migratedDirectoryDb();
  const clientId = await register(dir);
  const res = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge_method=plain&code_challenge=abc&state=s1`,
    {}, env(dir));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, CLAUDE_CB);
  assert.equal(loc.searchParams.get("error"), "invalid_request");
  // The state must come back with the error, or the client cannot match it to its own request.
  assert.equal(loc.searchParams.get("state"), "s1");
});

/** Drives register → authorize → consent → code, and returns everything the token call needs. */
async function upToCode(dir: MemDb) {
  const user = await seedUser(dir);
  const clientId = await register(dir);
  const cookie = `__Host-mt_session=${await createSession({ SESSION_SECRET: KEY } as never, user.id, user.token_version ?? 0)}`;
  const verifier = "v".repeat(64);
  const challenge = (await import("node:crypto")).createHash("sha256").update(verifier)
    .digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const page = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=${challenge}&code_challenge_method=S256&state=st1&resource=${encodeURIComponent("http://money.example/mcp")}`,
    { headers: { cookie } }, env(dir));
  assert.equal(page.status, 200);
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.ok(request, "the consent page must carry a signed request blob");

  const decided = await oauth.request("http://money.example/oauth/authorize",
    { ...form({ request, decision: "allow" }), headers: { "content-type": "application/x-www-form-urlencoded", cookie } },
    env(dir));
  assert.equal(decided.status, 302);
  const back = new URL(decided.headers.get("location")!);
  assert.equal(back.searchParams.get("state"), "st1");
  return { dir, clientId, verifier, code: back.searchParams.get("code")!, user };
}

/**
 * §MCP-OAUTH — the SECOND client, pinned beside Claude.
 *
 * Everything here is registered through DCR, so in principle no callback needs to be known in
 * advance — but «in principle» is exactly what this project does not accept as evidence, and only
 * one client has ever actually connected. So the shapes another assistant registers are asserted:
 * a plain HTTPS callback with a path, one carrying a query string, and one on a different host.
 * If a future change tightens `redirectAllowed` in a way that happens to suit claude.ai, this is
 * where it fails rather than in someone's connector dialog.
 */

test("a full flow yields an access token that verifies for THIS server", async () => {
  const { dir, clientId, verifier, code, user } = await upToCode(migratedDirectoryDb());
  const res = await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier,
  }), env(dir));
  assert.equal(res.status, 200);
  const body = await res.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.refresh_token);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const claim = await verifyAccessToken({ SESSION_SECRET: KEY } as never, body.access_token, "http://money.example/mcp");
  assert.equal(claim?.userId, user.id);
});

test("another client cannot redeem someone else's code", async () => {
  const { dir, verifier, code } = await upToCode(migratedDirectoryDb());
  const other = await register(dir, ["https://claude.ai/api/mcp/auth_callback"]);
  const res = await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: other, code_verifier: verifier,
  }), env(dir));
  assert.equal((await res.json() as { error: string }).error, "invalid_grant");
});

test("a disabled account cannot exchange a code it obtained while active", async () => {
  const { dir, clientId, verifier, code, user } = await upToCode(migratedDirectoryDb());
  await setUserStatus(dir as unknown as D1Database, user.id, "disabled");
  const res = await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier,
  }), env(dir));
  assert.equal((await res.json() as { error: string }).error, "invalid_grant");
});
