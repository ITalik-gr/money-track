// Google OAuth (authorization-code flow) — the real front door for multi-user (PLATFORM.md §3).
//
// Google rather than a password: there is nothing to store, nothing to reset, nothing to leak,
// and the email arrives already verified — which matters because the email IS the whitelist key.
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env.ts";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS, signShortLived, verifyShortLived } from "../lib/platform/auth.ts";
import { ensureOwner, loginWithGoogle, isRefusal } from "../lib/platform/directory.ts";
import { signupAllowed } from "../lib/platform/demo.ts";
import { verifyInitData } from "../lib/platform/tg-auth.ts";
import { userForTgChat, findUserById } from "../lib/platform/directory.ts";

export const auth = new Hono<{ Bindings: Env }>();

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "mt_oauth_state";
const NONCE_COOKIE = "mt_oauth_nonce";
const NEXT_COOKIE = "mt_login_next";

/**
 * A post-login destination, narrowed to what cannot leave this origin.
 *
 * Must start with a single `/` — `//evil.example` and `/\\evil.example` are both read as
 * protocol-relative URLs by browsers, which is how a "path" becomes somebody else's site. An
 * absolute URL is refused outright rather than parsed and compared: there is no legitimate reason
 * for one here, so accepting any is a rule that only an attacker benefits from.
 */
function safeNext(v: string | undefined): string | null {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return null;
  return v.length <= 512 ? v : null;
}

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
  /**
   * Where to land afterwards (§MCP-OAUTH). Needed because `/oauth/authorize` can be reached by
   * someone who is not signed in, and dropping them on `/` would leave the window Claude opened
   * showing a dashboard while the connection it was opened for is abandoned mid-flow.
   *
   * ⚠️ SIGNED and carried in a cookie, never echoed through the query string: an unsigned `next`
   * on a login URL is an open redirect with a login page in front of it. `safeNext` additionally
   * refuses anything that is not a plain same-origin path.
   */
  const next = safeNext(c.req.query("next"));
  if (next) setCookie(c, NEXT_COOKIE, await signShortLived(c.env, next), cookieOpts);

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

  // The cookie is minted with the user's CURRENT generation; a later bump makes it stop
  // verifying (migration 0005). `?? 0` covers a directory that has not taken 0005 yet.
  // Attributes come from `SESSION_COOKIE_OPTS`, never inlined: the `__Host-` prefix has to be
  // satisfied by every Set-Cookie for this name, and a second hand-written list is how the
  // sign-out path ended up rejected by the browser.
  setCookie(c, SESSION_COOKIE, await createSession(c.env, user.id, user.token_version ?? 0), SESSION_COOKIE_OPTS);
  // Re-validated after unsigning: the signature proves we wrote it, `safeNext` proves it is still
  // the kind of value we meant to write. Both, because the two checks fail differently.
  const next = safeNext(await verifyShortLived(c.env, getCookie(c, NEXT_COOKIE)) ?? undefined);
  if (next) setCookie(c, NEXT_COOKIE, "", { ...SESSION_COOKIE_OPTS, maxAge: 0 });
  return c.redirect(next ?? "/", 302);
});

/**
 * Sign in from inside a Telegram Mini App.
 *
 * ⚠️ **This creates nothing.** It admits a session for an account that ALREADY linked this
 * Telegram chat — the row written by the signed `/start` deep link. Google remains the only way an
 * account comes into existence, so there is still one identity per person and one place that
 * decides whether a stranger may have one (`loginWithGoogle`).
 *
 * Why it exists at all: OAuth cannot complete inside the webview. Telegram opens the consent screen
 * in an outside browser, so the `state` cookie is never returned and the callback fails
 * `bad_state` — reported from a phone as «через гугл не можу зареєструватись». The environment
 * cannot do the flow, so the flow is replaced rather than patched.
 *
 * ⚠️ The credential is in the BODY, not a cookie, so there is nothing for a cross-site form to
 * replay: an attacker who cannot read `initData` cannot mint a session, and one who can read it
 * already sits inside the victim's Telegram.
 */
// The path says MINIAPP rather than «telegram» on purpose: `routes/setup.ts` already owns a
// `/telegram/*` prefix (the linking endpoints), and lint C7 keeps one prefix in one file so that
// «which handler wins» never depends on mount order. The two are unrelated doors anyway — one
// links a chat to an account that is already signed in, this one signs in.
auth.post("/miniapp", async (c) => {
  if (!c.env.TG_BOT_TOKEN) return c.json({ error: "telegram_not_configured" }, 503);
  const body = await c.req.json<{ init_data?: string }>().catch(() => ({} as { init_data?: string }));
  const tgUser = await verifyInitData(c.env.TG_BOT_TOKEN, String(body.init_data ?? ""));
  if (!tgUser) return c.json({ error: "bad_init_data" }, 401);

  // `tg_links` is keyed by CHAT, and in a private chat Telegram gives the chat the user's own id —
  // which is why linking refuses groups (`routes/telegram.ts`). Without that refusal this lookup
  // would let any member of a linked group sign in as its owner.
  let userId = await userForTgChat(c.env.DIRECTORY, String(tgUser.id));

  /**
   * The OWNER's deployment chat, which has no row (2026-08-22, reported: the Mini App said «not
   * linked» to the one person whose bot demonstrably works).
   *
   * The same asymmetry that made unlinking a no-op the day before: a `tg_links` row is written by
   * the signed `/start` deep link, but the owner never needs one — `worker/index.ts` routes their
   * chat by `TG_CHAT_ID` alone, and `tgTarget` pushes to it the same way. So an account can have a
   * fully working bot and nothing in the index, and every reader that consults only the index
   * concludes there is no link. It also covers a directory that has not taken migration 0008 yet,
   * where the lookup answers `null` for everybody.
   *
   * ⚠️ Same rule as everywhere else (`CLAUDE.md §Безпека`): a deployment-wide secret is the
   * OWNER'S, never a fallback for everyone. `TG_CHAT_ID` names exactly one chat, and it is
   * compared as text against the id Telegram just SIGNED — this is not a claim the caller makes.
   */
  if (!userId && c.env.TG_CHAT_ID && String(tgUser.id) === String(c.env.TG_CHAT_ID)) {
    const owner = await ensureOwner(c.env.DIRECTORY, (c.env.OWNER_EMAIL || "").trim().toLowerCase() || "owner@localhost");
    userId = owner.id;
  }
  if (!userId) return c.json({ error: "not_linked" }, 403);

  const user = await findUserById(c.env.DIRECTORY, userId);
  // The same two facts the request guard checks, asked here for the same reason: a disabled
  // account must not be handed a fresh 30-day cookie by a second door (§REVOKE).
  if (!user || user.status === "disabled") return c.json({ error: "not_linked" }, 403);

  setCookie(c, SESSION_COOKIE, await createSession(c.env, user.id, user.token_version ?? 0), SESSION_COOKIE_OPTS);
  return c.json({ ok: true });
});
