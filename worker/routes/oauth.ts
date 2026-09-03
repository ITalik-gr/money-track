/**
 * §MCP-OAUTH — the authorization flow: registration, consent, tokens.
 *
 * The discovery documents live in `wellknown.ts`; they are a different prefix and a different kind
 * of thing (static JSON describing this one), and C7 wants one file per prefix anyway.
 *
 * WHY THIS APP IS ITS OWN AUTHORIZATION SERVER rather than delegating to Google, whose OAuth it
 * already uses to log people in: Google can say WHO someone is, but the thing being granted here
 * is access to this account's ledger, which only this app knows about. Delegating would mean
 * accepting a Google-issued token as authority over Money Track data — a token issued for a
 * different audience, which is precisely what the MCP spec forbids. So Google stays the login, and
 * the grant is ours.
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env.ts";
import { SESSION_COOKIE, verifySession, signShortLived, verifyShortLived } from "../lib/platform/auth.ts";
import { findUserById } from "../lib/platform/directory.ts";
import { consentPage } from "../lib/platform/consent-page.ts";
import { cspForFormTarget } from "../lib/platform/security-headers.ts";
import type { ServerLocale } from "../lib/platform/i18n.ts";
import { st } from "../lib/platform/i18n.ts";
import {
  MCP_SCOPE, OFFLINE_SCOPE, ACCESS_TTL_SEC, canonicalResource, resourceMatches,
  redirectAllowed, redirectUriUsable, pkceVerifies, createAccessToken, issuerFor,
} from "../lib/platform/oauth.ts";
import {
  registerClient, findClient, touchClient, issueCode, redeemCode, createGrant, rotateGrant,
} from "../lib/platform/oauth-store.ts";

export const oauth = new Hono<{ Bindings: Env }>();

/**
 * The consent page has no application state to read a language from — it renders in a fresh window
 * Claude opened, with no `x-mt-locale` and no app shell. `Accept-Language` is the only signal that
 * exists, so it is the one used. Ukrainian only when the browser actually asks for it: guessing
 * from the deployment's owner would show a stranger's connector a language they cannot read.
 */
function pageLocale(c: Ctx): ServerLocale {
  return /\buk\b/i.test(c.req.header("accept-language") ?? "") ? "uk" : "en";
}

/** OAuth errors that happen BEFORE a redirect URI is trusted must not redirect. */
type Ctx = Context<{ Bindings: Env }>;

function badRequest(c: Ctx, error: string, desc: string) {
  return c.json({ error, error_description: desc }, 400);
}

/**
 * …and errors after it MUST go back to the client, or the flow hangs with no explanation.
 *
 * ⚠️ **Every response back to the client carries `iss` (RFC 9207, 2026-09-02).** A client that
 * talks to more than one authorization server cannot otherwise tell WHICH one answered, and the
 * mix-up attack that defends against is real enough that stricter clients — the ones this project
 * does not test against, because only Claude has ever connected — refuse a response without it.
 *
 * It is added HERE rather than at each call site so an error redirect cannot forget it: a client
 * validating `iss` treats a missing one as a rejected response, and an error that gets rejected as
 * malformed is an error the person never gets to read.
 *
 * ⚠️ Paired with `authorization_response_iss_parameter_supported` in the AS metadata, and the pair
 * is not optional in either direction: advertising it without sending it makes a strict client
 * refuse EVERY response, which is worse than never advertising it at all.
 */
function backToClient(redirectUri: string, params: Record<string, string>, issuer?: string): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  if (issuer) u.searchParams.set("iss", issuer);
  return u.toString();
}

// ---- RFC 7591: dynamic client registration --------------------------------------------------
//
// Open by design — that is what "dynamic" means, and the MCP spec expects it. It is not a hole:
// registering a client grants NOTHING. Every registration still has to walk a human through the
// consent screen under a real session before a single byte of anyone's data moves.
oauth.post("/oauth/register", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return badRequest(c, "invalid_client_metadata", "body must be JSON");
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length) return badRequest(c, "invalid_redirect_uri", "redirect_uris is required");
  if (uris.length > 8) return badRequest(c, "invalid_redirect_uri", "too many redirect_uris");
  // HTTPS or loopback only. Refused here, at the one moment the list can still be kept clean.
  const bad = uris.find((u) => !redirectUriUsable(u));
  if (bad) return badRequest(c, "invalid_redirect_uri", `unusable redirect_uri: ${bad}`);

  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : null;
  const client = await registerClient(c.env.DIRECTORY, name, uris);
  return c.json({
    client_id: client.client_id,
    client_id_issued_at: client.created_at,
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // Public client, always. Claude registers as one, PKCE is what protects the code, and issuing
    // a secret we would then have to store would add a stealable value that buys nothing.
    token_endpoint_auth_method: "none",
  }, 201, { "cache-control": "no-store" });
});

// ---- the authorization endpoint -------------------------------------------------------------

/**
 * The pending request travels through the consent page as ONE signed, base64url blob.
 *
 * ⚠️ Base64 and not raw JSON: `signShortLived` splits its token on ".", so any value containing a
 * dot comes back as `null` — and this one always contains a hostname. The failure is silent and
 * total (every consent submission reads as expired), which is exactly the shape of bug that a
 * green unit test on the signer would never show.
 */
function packRequest(p: PendingRequest): string {
  return btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unpackRequest(raw: string): PendingRequest | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as PendingRequest;
  } catch { return null; }
}

interface PendingRequest {
  u: string;   // user id — the account that saw the consent screen
  c: string;   // client id
  r: string;   // redirect uri
  h: string;   // PKCE challenge
  s: string;   // state
  sc: string;  // scope
  res: string; // resource
}

oauth.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const client = q.client_id ? await findClient(c.env.DIRECTORY, q.client_id) : null;
  // Unknown client, or a redirect URI that was never registered: both are refused HERE, in the
  // browser, and never bounced onward. Redirecting to an unverified URI is the open-redirect this
  // endpoint would otherwise be — the attacker supplies the destination.
  if (!client) return badRequest(c, "invalid_client", "unknown client_id");
  if (!q.redirect_uri || !redirectAllowed(q.redirect_uri, client.redirect_uris)) {
    return badRequest(c, "invalid_request", "redirect_uri does not match a registered value");
  }

  const state = q.state ?? "";
  const err = (e: string, d: string) =>
    c.redirect(backToClient(q.redirect_uri!, { error: e, error_description: d, state }, issuerFor(c.req.url)), 302);
  if (q.response_type !== "code") return err("unsupported_response_type", "only response_type=code is supported");
  if (q.code_challenge_method !== "S256" || !q.code_challenge) {
    // PKCE is mandatory and `plain` is not offered — see `pkceVerifies` for why.
    return err("invalid_request", "code_challenge with code_challenge_method=S256 is required");
  }
  const resource = canonicalResource(c.req.url);
  if (!resourceMatches(q.resource, resource)) return err("invalid_target", "resource does not name this server");

  // WHO is granting. The session cookie is the only authority; the request cannot name a user.
  const sess = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  const user = sess ? await findUserById(c.env.DIRECTORY, sess.userId) : null;
  const signedIn = sess && user && user.status !== "disabled" && sess.tokenVersion === (user.token_version ?? 0);
  if (!signedIn) {
    // Send them through the normal Google login and come back to this exact request. `next` is
    // path-only and validated on the far side — an absolute URL there would be an open redirect
    // wearing a login page.
    const here = new URL(c.req.url);
    return c.redirect(`/auth/google/start?next=${encodeURIComponent(here.pathname + here.search)}`, 302);
  }

  const pending: PendingRequest = {
    u: user.id, c: client.client_id, r: q.redirect_uri, h: q.code_challenge,
    s: state, sc: q.scope ?? MCP_SCOPE, res: resource,
  };
  const host = new URL(q.redirect_uri).hostname;
  /**
   * This page carries its OWN policy — see `cspForFormTarget`. The default `form-action 'self'`
   * blocked the submission outright, and the failure was silent: the button did nothing, the page
   * did not move, and the explanation only existed in a console the OAuth window does not show.
   */
  c.header("content-security-policy", cspForFormTarget(new URL(c.req.url).origin, q.redirect_uri));
  return c.html(consentPage({
    locale: pageLocale(c),
    clientName: client.client_name || client.client_id.slice(0, 8),
    redirectHost: host,
    // Every registered URI being loopback means nothing but a local process can receive this code
    // — which the spec asks us to say out loud, because a local process is not identifiable.
    isLoopback: client.redirect_uris.every((u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u)),
    email: user.email,
    request: await signShortLived(c.env, packRequest(pending)),
  }));
});

oauth.post("/oauth/authorize", async (c) => {
  const form = await c.req.parseBody();
  const raw = await verifyShortLived(c.env, typeof form.request === "string" ? form.request : undefined);
  // Expired or forged: there is no trusted redirect URI to send an error to, so it stops here.
  const p = raw ? unpackRequest(raw) : null;
  if (!p) return c.html(`<p>${st(pageLocale(c), "consentExpired")}</p>`, 400);

  // Re-check the session at DECISION time, and that it is the SAME account that was shown the
  // screen. Otherwise a consent page left open in one account could be submitted from another,
  // granting a client access to a ledger its owner never saw named.
  const sess = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!sess || sess.userId !== p.u) {
    return c.redirect(backToClient(p.r, { error: "access_denied", error_description: "session changed", state: p.s }, issuerFor(c.req.url)), 302);
  }
  if (form.decision !== "allow") {
    return c.redirect(backToClient(p.r, { error: "access_denied", state: p.s }, issuerFor(c.req.url)), 302);
  }

  const code = await issueCode(c.env.DIRECTORY, {
    user_id: p.u, client_id: p.c, redirect_uri: p.r, code_challenge: p.h, resource: p.res, scope: p.sc,
  });
  return c.redirect(backToClient(p.r, { code, state: p.s }, issuerFor(c.req.url)), 302);
});

// ---- the token endpoint ---------------------------------------------------------------------

/** RFC 6749 error shape. Claude keys its refresh behaviour off `invalid_grant` specifically. */
function tokenError(c: Ctx, error: string, desc: string, status: 400 | 401 = 400) {
  return c.json({ error, error_description: desc }, status, { "cache-control": "no-store" });
}

oauth.post("/oauth/token", async (c) => {
  // RFC 6749 §4.1.3 — form-encoded, and Claude sends both the exchange and the refresh that way.
  const form = await c.req.parseBody();
  const get = (k: string) => (typeof form[k] === "string" ? form[k] : undefined);
  const grantType = get("grant_type");
  const resource = canonicalResource(c.req.url);

  const issue = async (userId: string, clientId: string, scope: string, refreshToken: string) => {
    const user = await findUserById(c.env.DIRECTORY, userId);
    // The account may have been disabled or deleted between consent and redemption; a grant does
    // not outlive the account it was granted on.
    if (!user || user.status === "disabled") return tokenError(c, "invalid_grant", "account is not active");
    const access = await createAccessToken(c.env, userId, user.mcp_version ?? 0, resource);
    await touchClient(c.env.DIRECTORY, clientId);
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope,
    }, 200, { "cache-control": "no-store" });
  };

  if (grantType === "authorization_code") {
    const code = get("code");
    if (!code) return tokenError(c, "invalid_request", "code is required");
    const rec = await redeemCode(c.env.DIRECTORY, code);
    // Unknown, expired, or ALREADY REDEEMED — one answer for all three on purpose: distinguishing
    // them tells whoever is probing which codes once existed.
    if (!rec) return tokenError(c, "invalid_grant", "code is not valid");
    if (rec.client_id !== get("client_id")) return tokenError(c, "invalid_grant", "code was issued to another client");
    // The same redirect URI as the authorization request (OAuth 2.1 §4.1.3), byte-for-byte.
    if (rec.redirect_uri !== get("redirect_uri")) return tokenError(c, "invalid_grant", "redirect_uri mismatch");
    const verifier = get("code_verifier");
    if (!verifier || !(await pkceVerifies(verifier, rec.code_challenge))) {
      return tokenError(c, "invalid_grant", "PKCE verification failed");
    }
    if (!resourceMatches(get("resource"), rec.resource)) return tokenError(c, "invalid_target", "resource mismatch");

    const { refreshToken } = await createGrant(c.env.DIRECTORY, {
      user_id: rec.user_id, client_id: rec.client_id, scope: rec.scope, resource: rec.resource,
    });
    return issue(rec.user_id, rec.client_id, rec.scope, refreshToken);
  }

  if (grantType === "refresh_token") {
    const presented = get("refresh_token");
    if (!presented) return tokenError(c, "invalid_request", "refresh_token is required");
    // Rotation: the presented token dies in the same statement that accepts it.
    const rotated = await rotateGrant(c.env.DIRECTORY, presented);
    if (!rotated) return tokenError(c, "invalid_grant", "refresh token is not valid");
    const clientId = get("client_id");
    if (clientId && clientId !== rotated.grant.client_id) {
      return tokenError(c, "invalid_grant", "refresh token belongs to another client");
    }
    return issue(rotated.grant.user_id, rotated.grant.client_id, rotated.grant.scope, rotated.refreshToken);
  }

  return tokenError(c, "unsupported_grant_type", `unsupported grant_type: ${grantType ?? "(none)"}`);
});

export const SCOPES = [MCP_SCOPE, OFFLINE_SCOPE];
