/**
 * §MCP-OAUTH — the authorization server, tested from the attacker's side.
 *
 * Every scenario here is a way the flow can be WRONG WITHOUT LOOKING WRONG. A connector that works
 * proves almost nothing: the redirect matcher, the PKCE check and the audience tag are all
 * exercised identically by a legitimate client whether they are strict or wide open. So the
 * assertions are mostly about refusals — the code that never runs when everything is going well,
 * and therefore the code that a refactor can quietly delete.
 *
 * The three that would be worst, in order: a redirect URI that was never registered being honoured
 * (the authorization code is handed to whoever asked), an authorization code that can be redeemed
 * twice (a leaked code stays valuable), and a refresh token that survives its own rotation (a
 * stolen one never expires).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { oauth } from "../routes/oauth.ts";
import { wellKnown } from "../routes/wellknown.ts";
import { migratedDirectoryDb, type MemDb } from "./harness.ts";
import { createSession, createMcpToken } from "../lib/platform/auth.ts";
import { inviteUser, setUserStatus } from "../lib/platform/directory.ts";
import {
  redirectAllowed, redirectUriUsable, resourceMatches, pkceVerifies,
  createAccessToken, verifyAccessToken, canonicalResource, randomToken, sha256Hex,
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

test("the resource may vary only in the ways the spec allows", () => {
  assert.equal(resourceMatches("https://money.example/mcp", RESOURCE), true);
  assert.equal(resourceMatches("https://money.example/mcp/", RESOURCE), true);
  assert.equal(resourceMatches("HTTPS://MONEY.EXAMPLE/mcp", RESOURCE), true);
  assert.equal(resourceMatches("https://other.example/mcp", RESOURCE), false);
  assert.equal(resourceMatches("https://money.example/admin", RESOURCE), false);
  // Absent is accepted and defaulted — see the note on `resourceMatches`.
  assert.equal(resourceMatches(undefined, RESOURCE), true);
});

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

test("an unknown code is refused", async () => {
  const dir = migratedDirectoryDb() as unknown as D1Database;
  assert.equal(await redeemCode(dir, randomToken()), null);
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

test("protected resource metadata names this server and its authorization server", async () => {
  const res = await wellKnown.request("http://money.example/.well-known/oauth-protected-resource", {}, env(migratedDirectoryDb()));
  const body = await res.json() as { resource: string; authorization_servers: string[] };
  // Must equal the MCP URL exactly as the user types it into Claude, path included.
  assert.equal(body.resource, "http://money.example/mcp");
  assert.equal(body.authorization_servers[0], "http://money.example");
});

test("the path-suffixed metadata probe answers too", async () => {
  const res = await wellKnown.request("http://money.example/.well-known/oauth-protected-resource/mcp", {}, env(migratedDirectoryDb()));
  assert.equal(res.status, 200);
});

test("authorization server metadata advertises S256 and offline_access", async () => {
  const res = await wellKnown.request("http://money.example/.well-known/oauth-authorization-server", {}, env(migratedDirectoryDb()));
  const m = await res.json() as Record<string, string[] | string>;
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  // Claude only asks for a refresh token when this scope is advertised; without it the connector
  // works for exactly one hour and then stops, which reads as an unstable server.
  assert.ok((m.scopes_supported as string[]).includes("offline_access"));
  assert.ok(m.registration_endpoint);
});

test("discovery answers on the OIDC path too, and to a preflight", async () => {
  // `openid-configuration` predates RFC 8414 by years, so a client written against OIDC habits
  // probes it FIRST and reports an unreachable server on a 404 — the same silent symptom
  // §MCP-OAUTH already documents for a missing /.well-known route.
  const dir = migratedDirectoryDb();
  const oidc = await wellKnown.request("http://money.example/.well-known/openid-configuration", {}, env(dir));
  const rfc = await wellKnown.request("http://money.example/.well-known/oauth-authorization-server", {}, env(dir));
  assert.equal(oidc.status, 200);
  assert.deepEqual(await oidc.json(), await rfc.json(), "one document, several names — never a second truth");

  // A browser-based client sends `MCP-Protocol-Version`, which makes the request non-simple; a
  // 404 to the preflight kills the fetch before the GET is ever attempted, and nothing reaches a
  // server log.
  const pre = await wellKnown.request("http://money.example/.well-known/oauth-authorization-server",
    { method: "OPTIONS" }, env(dir));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /mcp-protocol-version/);
});

test("metadata advertises RFC 9207 and RFC 8707 — and both claims are TRUE", async () => {
  const res = await wellKnown.request("http://money.example/.well-known/oauth-authorization-server", {}, env(migratedDirectoryDb()));
  const m = await res.json() as Record<string, unknown>;
  // Advertising `iss` without sending it makes a strict client refuse EVERY response — worse than
  // never advertising. The flow test below is the other half of this assertion.
  assert.equal(m.authorization_response_iss_parameter_supported, true);
  assert.equal(m.resource_indicators_supported, true);
});

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

test("registration refuses a redirect URI that could leak the code", async () => {
  const dir = migratedDirectoryDb();
  const res = await oauth.request("http://money.example/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
  }, env(dir));
  assert.equal(res.status, 400);
});

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

test("authorize sends a signed-out visitor through login and back to the same request", async () => {
  const dir = migratedDirectoryDb();
  const clientId = await register(dir);
  const res = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256`,
    {}, env(dir));
  assert.equal(res.status, 302);
  const loc = res.headers.get("location") ?? "";
  assert.match(loc, /^\/auth\/google\/start\?next=/);
  assert.match(decodeURIComponent(loc), /\/oauth\/authorize\?/);
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
const OPENAI_CB = "https://chatgpt.com/connector_platform_oauth_redirect";

test("a second assistant's callback registers and completes the flow, exactly like Claude's", async () => {
  const dir = migratedDirectoryDb();
  const user = await seedUser(dir);
  // Registered TOGETHER: one client may legitimately carry several callbacks, and the point is
  // that neither is special-cased.
  const clientId = await register(dir, [CLAUDE_CB, OPENAI_CB, `${OPENAI_CB}?v=2`]);
  const cookie = `__Host-mt_session=${await createSession({ SESSION_SECRET: KEY } as never, user.id, user.token_version ?? 0)}`;

  const page = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(OPENAI_CB)}&code_challenge=${"z".repeat(43)}&code_challenge_method=S256&state=st2`,
    { headers: { cookie } }, env(dir));
  assert.equal(page.status, 200, "an unfamiliar but registered callback reaches the consent page");

  const html = await page.text();
  // §MCP-OAUTH: the consent page carries its OWN CSP, derived from the verified redirect_uri —
  // `form-action 'self'` once blocked the Allow button in production and the symptom was silence.
  // The derivation must include THIS client's origin, not a hardcoded claude.ai.
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /form-action/);
  assert.ok(csp.includes("https://chatgpt.com"), `the consent CSP must name the client's origin: ${csp}`);

  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.ok(request);
  const decided = await oauth.request("http://money.example/oauth/authorize",
    { ...form({ request, decision: "allow" }), headers: { "content-type": "application/x-www-form-urlencoded", cookie } },
    env(dir));
  assert.equal(decided.status, 302);
  const back = new URL(decided.headers.get("location")!);
  assert.equal(back.origin + back.pathname, OPENAI_CB);
  assert.ok(back.searchParams.get("code"));
  assert.equal(back.searchParams.get("state"), "st2");
  // RFC 9207: the metadata says we send `iss`, so we must actually send it — a strict client that
  // read the flag and got no `iss` rejects the response and the flow dies at the last step.
  assert.equal(back.searchParams.get("iss"), "http://money.example");
});

test("an error response carries `iss` too, or a strict client discards the explanation", async () => {
  const dir = migratedDirectoryDb();
  const clientId = await register(dir, [OPENAI_CB]);
  const res = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(OPENAI_CB)}&code_challenge_method=plain&code_challenge=abc&state=s9`,
    {}, env(dir));
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.searchParams.get("error"), "invalid_request");
  assert.equal(loc.searchParams.get("iss"), "http://money.example");
});

test("the consent screen names the account and the destination", async () => {
  const dir = migratedDirectoryDb();
  const user = await seedUser(dir);
  const clientId = await register(dir);
  const cookie = `__Host-mt_session=${await createSession({ SESSION_SECRET: KEY } as never, user.id, user.token_version ?? 0)}`;
  const page = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=${"y".repeat(43)}&code_challenge_method=S256`,
    { headers: { cookie } }, env(dir));
  const html = await page.text();
  assert.match(html, /owner@example\.com/);
  // The redirect host is the one field an attacker controls and the one the spec insists is shown.
  assert.match(html, /claude\.ai/);
  assert.match(html, /Claude/);
});

test("the consent page permits its own submission AND the client's callback", async () => {
  const dir = migratedDirectoryDb();
  const user = await seedUser(dir);
  const clientId = await register(dir);
  const cookie = `__Host-mt_session=${await createSession({ SESSION_SECRET: KEY } as never, user.id, user.token_version ?? 0)}`;
  const page = await oauth.request(
    `http://money.example/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CB)}&code_challenge=${"y".repeat(43)}&code_challenge_method=S256`,
    { headers: { cookie } }, env(dir));
  const csp = page.headers.get("content-security-policy") ?? "";
  const formAction = /form-action ([^;]+)/.exec(csp)?.[1] ?? "";
  /**
   * The bug this pins: with a bare `form-action 'self'` the Allow button did nothing at all. The
   * page origin is written out beside `'self'` because `'self'` resolves against the DOCUMENT
   * origin, which is opaque inside a sandboxed OAuth window; the callback origin is there because
   * the submission answers with a redirect to it, and Chrome checks that too.
   */
  assert.match(formAction, /http:\/\/money\.example/);
  assert.match(formAction, /https:\/\/claude\.ai/);
  // Still narrow: only the destination this very code is about to be sent to.
  assert.doesNotMatch(formAction, /\*/);
  /**
   * ⚠️ What this CANNOT prove: that the header survives the security-header middleware in
   * `worker/index.ts`, which overwrites every other one. That file imports the Durable Object and
   * therefore `cloudflare:workers`, which plain Node cannot load, so the whole worker is out of
   * reach here. That half was verified against a running server instead — and it is the half that
   * was actually broken, so this note exists to stop the green tick from reading as full cover.
   */
});

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

test("the code cannot be redeemed twice", async () => {
  const { dir, clientId, verifier, code } = await upToCode(migratedDirectoryDb());
  const args = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier };
  assert.equal((await oauth.request("http://money.example/oauth/token", form(args), env(dir))).status, 200);
  const second = await oauth.request("http://money.example/oauth/token", form(args), env(dir));
  assert.equal(second.status, 400);
  assert.equal((await second.json() as { error: string }).error, "invalid_grant");
});

test("a wrong code_verifier is refused", async () => {
  const { dir, clientId, code } = await upToCode(migratedDirectoryDb());
  const res = await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: "z".repeat(64),
  }), env(dir));
  assert.equal((await res.json() as { error: string }).error, "invalid_grant");
});

test("another client cannot redeem someone else's code", async () => {
  const { dir, verifier, code } = await upToCode(migratedDirectoryDb());
  const other = await register(dir, ["https://claude.ai/api/mcp/auth_callback"]);
  const res = await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: other, code_verifier: verifier,
  }), env(dir));
  assert.equal((await res.json() as { error: string }).error, "invalid_grant");
});

test("refresh returns a NEW refresh token and invalidates the old one", async () => {
  const { dir, clientId, verifier, code } = await upToCode(migratedDirectoryDb());
  const first = await (await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier,
  }), env(dir))).json() as { refresh_token: string };

  const res = await oauth.request("http://money.example/oauth/token",
    form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }), env(dir));
  assert.equal(res.status, 200);
  const next = await res.json() as { refresh_token: string; access_token: string };
  assert.notEqual(next.refresh_token, first.refresh_token);

  const replay = await oauth.request("http://money.example/oauth/token",
    form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }), env(dir));
  // `invalid_grant` specifically: Claude keys its re-authentication behaviour off that code, and
  // any other one leaves the connector retrying a token that will never work again.
  assert.equal((await replay.json() as { error: string }).error, "invalid_grant");
});

test("a disabled account cannot exchange a code it obtained while active", async () => {
  const { dir, clientId, verifier, code, user } = await upToCode(migratedDirectoryDb());
  await setUserStatus(dir as unknown as D1Database, user.id, "disabled");
  const res = await oauth.request("http://money.example/oauth/token", form({
    grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier,
  }), env(dir));
  assert.equal((await res.json() as { error: string }).error, "invalid_grant");
});

test("an unsupported grant type is named, not silently ignored", async () => {
  const dir = migratedDirectoryDb();
  const res = await oauth.request("http://money.example/oauth/token",
    form({ grant_type: "client_credentials" }), env(dir));
  assert.equal((await res.json() as { error: string }).error, "unsupported_grant_type");
});

test("canonicalResource is derived from the request, not configured", () => {
  assert.equal(canonicalResource("https://money.italik.dev/oauth/token"), "https://money.italik.dev/mcp");
});
