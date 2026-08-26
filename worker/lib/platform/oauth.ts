/**
 * §MCP-OAUTH — the pieces of an OAuth 2.1 authorization server that are pure logic.
 *
 * Split from `routes/oauth.ts` (transport) for the reason C3 exists, and from `oauth-store.ts`
 * (the three tables) because these are the parts where a mistake is INVISIBLE: a redirect matcher
 * that is one comparison too loose, an audience check that passes anything, a PKCE verifier that
 * accepts a wrong verifier. None of those fail in normal use — they fail only when someone is
 * attacking, which is when nobody is watching. They live together, next to their reasons, and
 * `worker/test/oauth.test.ts` asserts each of them from the attacker's side.
 */
import type { Env } from "../../env.ts";
import { hmacHex, signingKey, timingSafeEqual } from "./auth.ts";

/** The one scope this server issues. Read access to the ledger; there is nothing else to grant. */
export const MCP_SCOPE = "mcp:read";
/** Advertised so Claude asks for a refresh token — it only does when the AS lists this. */
export const OFFLINE_SCOPE = "offline_access";

export const ACCESS_TTL_SEC = 60 * 60;
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 60;
export const CODE_TTL_SEC = 120;

/**
 * The canonical resource identifier of this MCP server (RFC 8707 §2).
 *
 * Derived from the request's own origin rather than configured: this app is deployed under one
 * hostname it does not know at build time, and a hard-coded value would make every preview
 * deployment fail audience validation with an error that says nothing about hostnames.
 */
export function canonicalResource(reqUrl: string): string {
  return `${new URL(reqUrl).origin}/mcp`;
}

export function issuerFor(reqUrl: string): string {
  return new URL(reqUrl).origin;
}

/**
 * Does the `resource` the client asked for name US?
 *
 * Lenient in the two ways the spec calls out (case of scheme/host, an optional trailing slash),
 * strict in every other. ⚠️ **An absent `resource` is accepted and defaulted.** Clients MUST send
 * it, and Claude does; refusing the ones that do not would turn a spec-compliance gap in someone
 * else's client into "this server is broken" — while accepting it costs nothing, because the
 * token is then bound to OUR canonical resource regardless of what was asked.
 */
export function resourceMatches(asked: string | undefined, canonical: string): boolean {
  if (!asked) return true;
  const norm = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.protocol.toLowerCase()}//${p.host.toLowerCase()}${p.pathname.replace(/\/$/, "")}`;
    } catch { return ""; }
  };
  const a = norm(asked);
  return a !== "" && a === norm(canonical);
}

/**
 * Exact redirect-URI matching, with ONE deliberate exception: the port of a loopback address.
 *
 * RFC 8252 §7.3 requires it, and Claude Code depends on it — it declares
 * `http://localhost/callback` and `http://127.0.0.1/callback` but binds an ephemeral port per
 * session, so a byte-exact comparison would reject every single Claude Code connection while
 * looking perfectly correct in a test that only tried claude.ai.
 *
 * ⚠️ The exception is the PORT and nothing else. Host, scheme and path still have to match, and
 * only loopback hosts get the exemption — extending it to any host would turn the pre-registered
 * list into a suggestion.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function redirectAllowed(asked: string, registered: string[]): boolean {
  let a: URL;
  try { a = new URL(asked); } catch { return false; }
  return registered.some((r) => {
    let b: URL;
    try { b = new URL(r); } catch { return false; }
    if (a.protocol !== b.protocol || a.pathname !== b.pathname || a.search !== b.search) return false;
    if (a.hostname !== b.hostname) return false;
    return LOOPBACK.has(a.hostname.toLowerCase()) ? true : a.port === b.port;
  });
}

/**
 * A redirect URI may only be HTTPS, or loopback over plain HTTP (OAuth 2.1 §1.5, RFC 8252).
 *
 * Checked at REGISTRATION, so a `http://evil.example` can never enter the stored list — the point
 * where a bad value is cheapest to refuse and hardest to notice later.
 */
export function redirectUriUsable(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK.has(u.hostname.toLowerCase());
  } catch { return false; }
}

async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex — how a refresh token is stored, so the table is not a set of working keys. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * PKCE, S256 only.
 *
 * `plain` is deliberately unsupported and un-advertised: it makes the challenge equal to the
 * verifier, so an intercepted authorization request carries everything needed to redeem the code
 * — which is the exact attack PKCE exists to stop.
 */
export async function pkceVerifies(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return timingSafeEqual(await sha256b64url(verifier), challenge);
}

/** Random, URL-safe, 256 bits. Used for codes, client ids and refresh tokens. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ACCESS TOKEN — stateless, short-lived, and BOUND TO ONE AUDIENCE.
 *
 * `mtoat1.<userId>.<exp>.<mcpVersion>.<audTag>.<hmac>`, a sibling of the personal token in
 * `auth.ts` and separated from it by the prefix, which is inside the signature.
 *
 * ⚠️ `audTag` is what the spec means by "MCP servers MUST validate that tokens were issued
 * specifically for them". It is a tag over the canonical resource, so a token minted for a
 * different deployment of this same codebase — same signing key, different hostname — does not
 * verify here. Without it, one leaked key would make every deployment interchangeable.
 *
 * ⚠️ `mcpVersion` rides along exactly as in the personal token, so ONE kill switch
 * (`users.mcp_version`) ends every kind of MCP access at once. Two revocation stories for one
 * button is how a "revoke" that only half-works gets shipped.
 */
const ACCESS_PREFIX = "mtoat1";

export async function createAccessToken(
  env: Env, userId: string, mcpVersion: number, resource: string,
): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC;
  const aud = (await hmacHex(key, `aud:${resource}`)).slice(0, 16);
  const payload = `${ACCESS_PREFIX}.${userId}.${exp}.${mcpVersion}.${aud}`;
  return `${payload}.${await hmacHex(key, payload)}`;
}

export async function verifyAccessToken(
  env: Env, token: string | undefined, resource: string,
): Promise<{ userId: string; mcpVersion: number } | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [prefix, userId, exp, mv, aud, sig] = parts as [string, string, string, string, string, string];
  if (prefix !== ACCESS_PREFIX) return null;
  if (!/^[0-9a-f]+$/.test(userId) || !/^\d+$/.test(exp) || !/^\d+$/.test(mv)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const expectedAud = (await hmacHex(key, `aud:${resource}`)).slice(0, 16);
  if (!timingSafeEqual(aud, expectedAud)) return null;
  const expected = await hmacHex(key, `${prefix}.${userId}.${exp}.${mv}.${aud}`);
  return timingSafeEqual(sig, expected) ? { userId, mcpVersion: Number(mv) } : null;
}
