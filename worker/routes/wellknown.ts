/**
 * §MCP-OAUTH — the two discovery documents, and the reason they are their own file.
 *
 * A client that cannot find these never reaches the flow at all: the symptom is "couldn't reach
 * the MCP server", with the authorization endpoints seeing no traffic whatsoever. Anthropic's own
 * documentation names this deployment shape — a Cloudflare Worker without a `/.well-known/*`
 * route — as a common cause, which is why `wrangler.jsonc` lists the prefix in
 * `assets.run_worker_first`: without that line the static asset router answers with the SPA shell
 * and the JSON never exists.
 */
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { canonicalResource, issuerFor, MCP_SCOPE, OFFLINE_SCOPE } from "../lib/platform/oauth.ts";

export const wellKnown = new Hono<{ Bindings: Env }>();

/**
 * Public, cacheable, and CORS-open.
 *
 * `access-control-allow-origin: *` because these documents are the definition of public: they
 * describe endpoints anyone may call, and contain nothing about anyone. Serving them without it
 * makes browser-based clients fail at discovery for a reason that never appears in a server log.
 */
const PUBLIC = {
  "cache-control": "public, max-age=3600",
  "access-control-allow-origin": "*",
} as const;

/**
 * RFC 9728 — protected resource metadata.
 *
 * ⚠️ `resource` MUST equal the MCP URL exactly as the user typed it into Claude, path included.
 * That is why it is derived from the request rather than configured: a mismatch here is rejected
 * by the client with a message about metadata, not about hostnames.
 *
 * Served at BOTH the bare path and the path-suffixed one, because a client that did not get our
 * `WWW-Authenticate` pointer probes `/.well-known/oauth-protected-resource/mcp` first and the bare
 * path second. Two routes, one document — the fallback path costs nothing and removes a whole
 * class of "it works for me" difference between clients.
 */
function protectedResource(reqUrl: string) {
  return {
    resource: canonicalResource(reqUrl),
    authorization_servers: [issuerFor(reqUrl)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
  };
}
wellKnown.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource(c.req.url), 200, PUBLIC));
wellKnown.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource(c.req.url), 200, PUBLIC));

/**
 * RFC 8414 — authorization server metadata.
 *
 * ⚠️ `offline_access` in `scopes_supported` is not decoration: Claude appends that scope, and so
 * asks for a refresh token, ONLY when the server advertises it here. Without the line the
 * connector works for exactly one hour and then silently stops, which reads as an unstable server
 * rather than as a missing string.
 *
 * ⚠️ `code_challenge_methods_supported: ["S256"]` is required by the MCP spec so a client can
 * verify PKCE support BEFORE starting a flow. `plain` is absent because it is not implemented —
 * advertising it would be an invitation to downgrade.
 */
function authServer(reqUrl: string) {
  const issuer = issuerFor(reqUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: [MCP_SCOPE, OFFLINE_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Public clients only; the registration endpoint issues no secrets.
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${issuer}/`,
    /**
     * RFC 9207 (2026-09-02). Advertised because the authorization response actually carries `iss`
     * — the two go together and neither is safe alone: advertising without sending makes a strict
     * client refuse EVERY response, and sending without advertising leaves a client that would
     * have validated it unable to know it may.
     */
    authorization_response_iss_parameter_supported: true,
    /**
     * RFC 8707. Already enforced — a code carries the `resource` it was issued for and the access
     * token is audience-bound to it — but never SAID. A client that checks this flag before
     * sending `resource` would silently omit it, and the omission is invisible until an audience
     * check fails somewhere else entirely.
     */
    resource_indicators_supported: true,
  };
}
wellKnown.get("/.well-known/oauth-authorization-server", (c) => c.json(authServer(c.req.url), 200, PUBLIC));
// Some clients derive the AS metadata path from the issuer's path component. Ours has none, but
// the suffixed form is what they try first, and answering both costs one line.
wellKnown.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authServer(c.req.url), 200, PUBLIC));

/**
 * OpenID Connect discovery, as an ALIAS of the same document (2026-09-02).
 *
 * This server is not an OpenID Provider and does not claim to be — there is no `id_token` here and
 * none is advertised. But `openid-configuration` predates RFC 8414 by years, so a client written
 * against OIDC habits probes it FIRST and, on a 404, reports that it could not reach the server at
 * all. That is the exact symptom §MCP-OAUTH already documents for a missing `/.well-known/*` route,
 * and it is the one this project cannot see, because only Claude has ever connected.
 *
 * ⚠️ The document is the RFC 8414 one, unchanged. Fabricating OIDC-only fields (`userinfo_endpoint`,
 * `id_token_signing_alg_values_supported`) to look more like an OP would advertise endpoints that
 * do not exist — a client following them would fail LATER and further from the cause.
 */
wellKnown.get("/.well-known/openid-configuration", (c) => c.json(authServer(c.req.url), 200, PUBLIC));
wellKnown.get("/.well-known/openid-configuration/mcp", (c) => c.json(authServer(c.req.url), 200, PUBLIC));

/**
 * A preflight for every document above.
 *
 * `access-control-allow-origin: *` on the GET is not enough for a browser-based client that sends
 * `MCP-Protocol-Version` (the spec tells it to): a custom request header makes the request
 * non-simple, so the browser asks first — and a 404 to that OPTIONS kills the fetch before the GET
 * is ever attempted. Nothing reaches a server log, so the failure looks like an unreachable host.
 */
wellKnown.options("/.well-known/*", (c) => c.body(null, 204, {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
}));
