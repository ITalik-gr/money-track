// Google OAuth (authorization-code flow) — the real front door for multi-user (PLATFORM.md §3).
//
// Google rather than a password: there is nothing to store, nothing to reset, nothing to leak,
// and the email arrives already verified — which matters because the email IS the whitelist key.
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env.ts";
import { createSession, SESSION_COOKIE, signShortLived, verifyShortLived } from "../lib/platform/auth.ts";
import { ensureOwner, loginWithGoogle, isRefusal } from "../lib/platform/directory.ts";
import { signupAllowed } from "../lib/platform/demo.ts";

export const auth = new Hono<{ Bindings: Env }>();

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "mt_oauth_state";
const NONCE_COOKIE = "mt_oauth_nonce";

/** Callback URL must match the one registered in Google Cloud Console, byte for byte. */
function redirectUri(reqUrl: string): string {
  return new URL("/auth/google/callback", reqUrl).toString();
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    // atob yields latin1; re-decode as UTF-8 so non-ASCII names survive.
    const bytes = Uint8Array.from(json, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

auth.get("/google/start", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "google_oauth_not_configured" }, 503);
  }
  // `state` defeats CSRF on the callback, `nonce` binds the id_token to THIS flow. Both are
  // signed and echoed through a short-lived cookie, so a callback we did not start fails.
  const state = crypto.randomUUID().replace(/-/g, "");
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 } as const;
  setCookie(c, STATE_COOKIE, await signShortLived(c.env, state), cookieOpts);
  setCookie(c, NONCE_COOKIE, await signShortLived(c.env, nonce), cookieOpts);

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(c.req.url));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  // Force the account chooser: several friends have more than one Google account, and a
  // silent sign-in with the wrong one looks like "the app lost my data".
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString(), 302);
});

auth.get("/google/callback", async (c) => {
  const fail = (reason: string) => c.redirect(`/login?error=${encodeURIComponent(reason)}`, 302);

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return fail("missing_code");

  const expectedState = await verifyShortLived(c.env, getCookie(c, STATE_COOKIE));
  const expectedNonce = await verifyShortLived(c.env, getCookie(c, NONCE_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  deleteCookie(c, NONCE_COOKIE, { path: "/" });
  if (!expectedState || expectedState !== state) return fail("bad_state");

  const body = new URLSearchParams({
    code,
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(c.req.url),
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error("[auth] google token exchange failed:", res.status, await res.text());
    return fail("token_exchange_failed");
  }
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) return fail("no_id_token");

  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims) return fail("bad_id_token");

  // The id_token's SIGNATURE is deliberately not verified: it was just fetched over TLS
  // directly from Google's token endpoint in exchange for our client secret, so its
  // authenticity comes from the channel, not the JWS. (Signature checking is required only
  // for tokens received from a client.) The CLAIMS still have to be checked — a valid token
  // issued for a different application would otherwise be accepted here.
  const iss = String(claims["iss"] ?? "");
  const aud = String(claims["aud"] ?? "");
  const exp = Number(claims["exp"] ?? 0);
  const nonce = String(claims["nonce"] ?? "");
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return fail("bad_issuer");
  if (aud !== c.env.GOOGLE_CLIENT_ID) return fail("bad_audience");
  if (!exp || exp < Date.now() / 1000) return fail("expired_id_token");
  if (!expectedNonce || nonce !== expectedNonce) return fail("bad_nonce");
  if (claims["email_verified"] !== true) return fail("email_not_verified");

  const email = String(claims["email"] ?? "");
  const sub = String(claims["sub"] ?? "");
  if (!email || !sub) return fail("no_email");

  // The door is guarded entirely inside `loginWithGoogle` — one place to audit. Since
  // 2026-07-31 the default is OPEN signup: an unknown address gets a row and a sandbox of its
  // own. `SIGNUP=invite` in `wrangler.jsonc` puts the whitelist back without touching code.
  const profile = {
    sub,
    email,
    name: claims["name"] ? String(claims["name"]) : undefined,
    picture: claims["picture"] ? String(claims["picture"]) : undefined,
  };
  const openSignup = (c.env.SIGNUP ?? "open") !== "invite";

  // The ceiling counts NEW accounts, not sign-ins — hence a callback: `loginWithGoogle` invokes
  // it only when it is about to create a row, so a day of returning users never spends the quota.
  let user = await loginWithGoogle(c.env.DIRECTORY, profile, {
    allowSignup: openSignup ? () => signupAllowed(c.env) : undefined,
  });

  // Bootstrap. On a fresh install the owner row used to be created as a side effect of the
  // password gate, which no longer exists. Seeding it here keeps that from being a lockout —
  // and it must stay even with open signup, because the owner needs `is_owner = 1`, which
  // self-registration deliberately never grants.
  const ownerEmail = (c.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (isRefusal(user) && ownerEmail && email.toLowerCase() === ownerEmail) {
    await ensureOwner(c.env.DIRECTORY, ownerEmail);
    user = await loginWithGoogle(c.env.DIRECTORY, profile);
  }
  // Distinct reasons: "we don't know you" and "you were shown out" are different facts, and a
  // disabled user told "not invited" will simply try again forever.
  if (isRefusal(user)) return fail(user);

  setCookie(c, SESSION_COOKIE, await createSession(c.env, user.id), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect("/", 302);
});
