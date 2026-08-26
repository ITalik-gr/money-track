/**
 * The response headers every request gets, in ONE place.
 *
 * Split out of `index.ts` on 2026-08-24 because the consent screen (§MCP-OAUTH) needs to state a
 * DIFFERENT `form-action` from every other page, and importing the list back from `index.ts`
 * would close a cycle — that file already imports the routes.
 */

/**
 * `form-action` for ordinary pages.
 *
 * ⚠️ The origin is written out ALONGSIDE `'self'` rather than instead of it, and that is the fix
 * for the bug that made the consent screen's "Allow" button do nothing (2026-08-24). Two things
 * can defeat a bare `'self'` here, and the console message looks identical for both:
 *   • `'self'` is resolved against the DOCUMENT's origin. A page opened inside a sandboxed
 *     webview — which is how a desktop client may present an OAuth window — has an OPAQUE origin,
 *     and an opaque origin matches nothing at all. The explicit URL still matches, because a
 *     source expression is compared against the URL being submitted to.
 *   • Chrome applies `form-action` to the REDIRECT that follows a submission, not only to the
 *     action URL. Our consent POST answers 302 to the client's callback, so the destination has to
 *     be listed too — see `cspForFormTarget`.
 * Neither shows up on any other page, because nothing else in this app posts a form at all.
 */
export function cspDirectives(formAction: string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self' https://web.telegram.org",
    "base-uri 'self'",
    `form-action ${formAction.join(" ")}`,
    "object-src 'none'",
  ].join("; ");
}

export const CSP = cspDirectives(["'self'"]);

/**
 * The consent page's policy: its own origin, plus the ONE place this particular authorization code
 * is about to be sent.
 *
 * Narrow by construction — the target is the `redirect_uri` that has already been checked against
 * the client's registered list, so this can only ever name a destination the flow was going to use
 * anyway. A blanket `form-action *` would have fixed the same symptom and given up the protection
 * for every future page at the same time.
 */
export function cspForFormTarget(pageOrigin: string, redirectUri: string): string {
  let target = "";
  try { target = new URL(redirectUri).origin; } catch { target = ""; }
  return cspDirectives(["'self'", pageOrigin, ...(target && target !== pageOrigin ? [target] : [])]);
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  // Stops a response typed `text/plain` from being sniffed into script/HTML.
  "x-content-type-options": "nosniff",
  // ⚠️ `x-frame-options` is GONE (2026-08-21) and cannot come back. It has no allow-list form —
  // `ALLOW-FROM` was removed from every browser — so `DENY` beside the CSP above would block the
  // Mini App anyway and make the CSP a lie about what the app permits. `frame-ancestors` is
  // honoured by every browser released since 2015 and takes precedence where both are sent; what
  // is lost is protection in browsers older than that, which cannot run this app regardless.
  // Full URLs of an app whose paths carry transaction ids are nobody else's business.
  "referrer-policy": "strict-origin-when-cross-origin",
  // Features this app never uses. Camera is deliberately NOT blocked: the receipt input uses
  // `capture`, and browsers that gate that on Permissions-Policy would break photo upload.
  "permissions-policy": "geolocation=(), microphone=(), payment=(), usb=()",
};
