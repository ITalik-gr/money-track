// Session handling. Stateless, HMAC-signed cookie — no session table, no directory lookup
// on every request (identity is resolved once, at login).
//
// The token carries the `userId`, which is also the name of that user's Durable Object.
// That is the whole point of the multi-user change: a request no longer asks "is someone
// logged in?" but "WHOSE database is this?", and the answer must be unforgeable.
import type { Env } from "../../env.ts";

/**
 * `__Host-` prefix (2026-08-01): the browser itself then enforces what we already set by hand —
 * Secure, `Path=/`, and NO `Domain` attribute. The last one is the point: without it, anything
 * that could set a cookie on a sibling subdomain could plant a session cookie that this origin
 * would happily read. Renaming logs everyone out once, which is why it shipped together with
 * `token_version` (that bump invalidates the old cookies anyway).
 */
export const SESSION_COOKIE = "__Host-mt_session";

/**
 * Cookie attributes for the session, in ONE place.
 *
 * ⚠️ The `__Host-` prefix is enforced on EVERY `Set-Cookie`, including the one that DELETES the
 * cookie. That is what broke logout the day the prefix shipped: the sign-out path cleared the
 * cookie with `{ path, maxAge: 0 }` and no `secure`, the browser rejected the header outright
 * ("__Host- Cookie must have Secure attributes"), and the session survived its own sign-out.
 * Exported as constants so a fourth call site cannot invent its own attribute list.
 */
export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
} as const;

/** Same attributes, zero lifetime — deletion still has to satisfy the prefix. */
export const CLEAR_COOKIE_OPTS = { ...SESSION_COOKIE_OPTS, maxAge: 0 } as const;
const TTL = 60 * 60 * 24 * 30; // 30 days
// v1 = the single-password era; v2 = pre-revocation tokens with no `token_version` field.
// Neither shape verifies any more — the payload has a different number of segments.
const VERSION = "v3";

/**
 * Key the session is signed with.
 *
 * `SESSION_SECRET` is the real answer; `APP_PASSWORD` is the fallback so the app keeps
 * working before that secret is set. Falling back matters: signing with a rotating password
 * meant every password change silently logged everyone out, and once Google OAuth is the
 * only door there is no password to sign with at all.
 */
function signingKey(env: Env): string | undefined {
  return env.SESSION_SECRET || env.APP_PASSWORD || undefined;
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Token shape: `v3.<userId>.<expiryUnix>.<tokenVersion>.<hmac>` — `userId` is hex, so `.` stays
 * a safe separator.
 *
 * `tokenVersion` is what makes a stateless session revocable. It is SIGNED, so it cannot be
 * edited, and it is compared against the user's current value from the directory row the guard
 * already reads. Bumping that value makes every cookie ever issued to that user stop matching:
 * signed out of every device, with no session table and no extra query on the hot path.
 */
export async function createSession(env: Env, userId: string, tokenVersion: number): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = String(Math.floor(Date.now() / 1000) + TTL);
  const payload = `${VERSION}.${userId}.${exp}.${tokenVersion}`;
  return `${payload}.${await hmacHex(key, payload)}`;
}

/**
 * Returns the signed-in `userId` and the `tokenVersion` the cookie was minted with, or `null`.
 * Never throws — a bad cookie is just "no".
 *
 * ⚠️ Verifying the signature is only HALF the check. The caller MUST still compare
 * `tokenVersion` with the directory's current value; a correctly signed cookie from before a
 * revocation is a valid signature over a stale claim.
 */
export async function verifySession(
  env: Env, token: string | undefined,
): Promise<{ userId: string; tokenVersion: number } | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [version, userId, exp, tv, sig] = parts as [string, string, string, string, string];
  if (version !== VERSION) return null;
  if (!/^[0-9a-f]+$/.test(userId) || !/^\d+$/.test(exp) || !/^\d+$/.test(tv)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const expected = await hmacHex(key, `${version}.${userId}.${exp}.${tv}`);
  return timingSafeEqual(sig, expected) ? { userId, tokenVersion: Number(tv) } : null;
}

/**
 * MCP bearer token: `mtmcp1.<userId>.<expiryUnix>.<mcpVersion>.<hmac>` (2026-08-23).
 *
 * A SECOND credential for the same account, held by a program rather than a browser — Claude
 * Code, or Claude Desktop through `mcp-remote`. Three properties are deliberate:
 *
 *   • **Its own generation number.** `mcp_version` (directory 0009), not `token_version`.
 *     Rotating the token that sits in an editor's config file must not sign the owner out of
 *     their phone, and the reverse matters more: "someone has my session" is answered by
 *     bumping `token_version`, and that answer would be wrong if it silently left a
 *     year-long API token alive.
 *   • **Its own prefix, so the two token types cannot be swapped.** The prefix is part of the
 *     SIGNED payload, so a session cookie is not a valid MCP token even for the same user with
 *     the same numbers — the HMAC simply does not match. Without that, one leaked credential
 *     would be usable wherever the other is accepted.
 *   • **A year, not thirty days.** It lives in a config file nobody reopens; a token that
 *     expires quietly turns into "the MCP server stopped working" with no visible cause.
 *     Length is affordable precisely BECAUSE it is revocable — see `revokeMcp`.
 *
 * ⚠️ Like `verifySession`, verifying the signature is only HALF the check: the caller must
 * still compare `mcpVersion` against the directory, and still check the account is not
 * disabled. A signature proves the number was not edited, not that it is still current.
 */
const MCP_VERSION = "mtmcp1";
const MCP_TTL = 60 * 60 * 24 * 365;

export async function createMcpToken(env: Env, userId: string, mcpVersion: number): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = String(Math.floor(Date.now() / 1000) + MCP_TTL);
  const payload = `${MCP_VERSION}.${userId}.${exp}.${mcpVersion}`;
  return `${payload}.${await hmacHex(key, payload)}`;
}

/** Returns the user and the generation the token claims, or `null`. Never throws. */
export async function verifyMcpToken(
  env: Env, token: string | undefined,
): Promise<{ userId: string; mcpVersion: number } | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [version, userId, exp, mv, sig] = parts as [string, string, string, string, string];
  if (version !== MCP_VERSION) return null;
  // Hex-only ids are also what keeps a demo sandbox out: its name is `demo:<random>`, which
  // cannot survive this test, so a sandbox can never hold an MCP token no matter what is signed.
  if (!/^[0-9a-f]+$/.test(userId) || !/^\d+$/.test(exp) || !/^\d+$/.test(mv)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const expected = await hmacHex(key, `${version}.${userId}.${exp}.${mv}`);
  return timingSafeEqual(sig, expected) ? { userId, mcpVersion: Number(mv) } : null;
}

/**
 * Per-user webhook path segment: `<userId>.<hmac>`.
 *
 * Derived rather than stored: a bank webhook URL is registered once and lives for years, so
 * a lookup table would be a row that must never be lost, in a database that is not the user's.
 * Signing lets any Worker instance verify the URL with no state at all. The `userId` is
 * already an opaque uuid, so carrying it in the path leaks nothing a session cookie doesn't.
 *
 * No expiry on purpose — the bank keeps calling this URL forever; rotation means re-registering.
 */
export async function webhookToken(env: Env, userId: string): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  return `${userId}.${await hmacHex(key, `webhook:${userId}`)}`;
}

/** Verifies a webhook path segment and returns the `userId` it belongs to, or `null`. */
export async function verifyWebhookToken(env: Env, token: string | undefined): Promise<string | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f]+$/.test(userId)) return null;
  const expected = await hmacHex(key, `webhook:${userId}`);
  return timingSafeEqual(sig, expected) ? userId : null;
}

// ---- demo sandbox (P4.2, PLATFORM.md §11) -----------------------------------
// A demo visitor has no directory account and no invite — the whole point is that a stranger
// (a recruiter) can look without one. Their identity is a signed random id in a SEPARATE cookie,
// and the Durable Object serving them is named `demo:<id>`. That `demo:` prefix keeps the demo
// namespace physically disjoint from real users (whose ids are bare hex): a demo cookie can never
// resolve to a real user's object, and a session cookie can never resolve to a demo one.
export const DEMO_COOKIE = "mt_demo";
const DEMO_VERSION = "demo";
const DEMO_TTL = 60 * 60 * 24; // 24h — matches the sandbox's self-destruct alarm

/** A fresh random demo id (hex), used both as the cookie subject and the `demo:<id>` DO name. */
export function newDemoId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Token shape: `demo.<demoId>.<expiryUnix>.<hmac>`. */
export async function createDemoToken(env: Env, demoId: string): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = String(Math.floor(Date.now() / 1000) + DEMO_TTL);
  const payload = `${DEMO_VERSION}.${demoId}.${exp}`;
  return `${payload}.${await hmacHex(key, payload)}`;
}

/** Returns the demo id, or `null`. Never throws. */
export async function verifyDemoToken(env: Env, token: string | undefined): Promise<string | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, demoId, exp, sig] = parts as [string, string, string, string];
  if (version !== DEMO_VERSION) return null;
  if (!/^[0-9a-f]+$/.test(demoId) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const expected = await hmacHex(key, `${version}.${demoId}.${exp}`);
  return timingSafeEqual(sig, expected) ? demoId : null;
}

/**
 * Short-lived signed value for the OAuth `state` and `nonce` round-trip.
 *
 * Signed rather than stored: a KV write plus a read on every login attempt buys nothing here,
 * since the only requirement is "this callback belongs to a flow WE started, recently".
 */
export async function signShortLived(env: Env, value: string, ttlSeconds = 600): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const payload = `${value}.${exp}`;
  return `${payload}.${await hmacHex(key, payload)}`;
}

/**
 * §D1 — one-shot token that ties a Telegram chat to a user account.
 *
 * A separate primitive from `signShortLived` because the carrier is hostile to its format:
 * Telegram's `?start=` payload allows at most 64 characters from `[A-Za-z0-9_-]`, and a
 * 32-char user id plus a full 64-char HMAC plus dot separators is nearly twice that. So:
 * `_` separators, base36 expiry, and the signature truncated to 16 hex chars.
 *
 * ⚠️ **The old rationale here said «no read access», and that stopped being true on 2026-08-21.**
 * It read: 64 bits is enough because a forged token would only point the attacker's own chat at a
 * stranger's NOTIFICATIONS — noisy for them, nothing to read. Multi-user inbound commands landed
 * that same night, and this token now also grants `/balance`, `/last`, `/stats`, `/budget`,
 * `/subs`, `/goals` and `/ask` against the account's whole transaction database. The sentence was
 * still there, still readable, and no longer describing the system — the third time in one day
 * that a stated FACT expired under a rule that depended on it (C10's Telegram exemption,
 * `budgets.rollover`, and now this).
 *
 * What holds it now, stated honestly:
 *  · the tag is **88 bits** (22 hex chars), which is what the 64-character `?start=` budget allows
 *    beside a 32-char user id and a base36 expiry — free, so taken;
 *  · the token dies in 15 minutes and is only useful inside that window;
 *  · a link that IS used by someone else is no longer silent: rebinding tells the chat that just
 *    lost the account (`tg-target.ts linkTgChat`). Forgery cannot be prevented by a short tag
 *    alone, but a takeover the owner hears about is a different kind of problem.
 * Same key and same timing-safe comparison as every other signed value in this file.
 */
const TG_LINK_TTL_SEC = 900;
/** 22 hex chars = 88 bits. Bounded by `?start=`: 32 (user id) + 1 + 7 (base36 exp) + 1 + 22 = 63. */
const TG_LINK_TAG_LEN = 22;

export async function telegramLinkToken(env: Env, userId: string): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = (Math.floor(Date.now() / 1000) + TG_LINK_TTL_SEC).toString(36);
  const payload = `${userId}_${exp}`;
  return `${payload}_${(await hmacHex(key, `tglink:${payload}`)).slice(0, TG_LINK_TAG_LEN)}`;
}

/** Verifies a `telegramLinkToken` and returns the `userId` it belongs to, or `null`. */
export async function verifyTelegramLinkToken(env: Env, token: string | undefined): Promise<string | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split("_");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts as [string, string, string];
  // Same shape check as `verifyWebhookToken`: a user id is hex, and anything else is a probe.
  if (!/^[0-9a-f]+$/.test(userId) || !/^[0-9a-z]+$/.test(exp)) return null;
  if (parseInt(exp, 36) < Date.now() / 1000) return null;
  const expected = (await hmacHex(key, `tglink:${userId}_${exp}`)).slice(0, TG_LINK_TAG_LEN);
  return timingSafeEqual(sig, expected) ? userId : null;
}

/** Verifies a `signShortLived` token and returns the original value, or `null`. */
export async function verifyShortLived(env: Env, token: string | undefined): Promise<string | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [value, exp, sig] = parts as [string, string, string];
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return null;
  const expected = await hmacHex(key, `${value}.${exp}`);
  return timingSafeEqual(sig, expected) ? value : null;
}
