// Session handling. Stateless, HMAC-signed cookie — no session table, no directory lookup
// on every request (identity is resolved once, at login).
//
// The token carries the `userId`, which is also the name of that user's Durable Object.
// That is the whole point of the multi-user change: a request no longer asks "is someone
// logged in?" but "WHOSE database is this?", and the answer must be unforgeable.
import type { Env } from "../../env.ts";

export const SESSION_COOKIE = "mt_session";
const TTL = 60 * 60 * 24 * 30; // 30 days
const VERSION = "v2"; // v1 = the single-password era; those tokens no longer verify

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

/** Token shape: `v2.<userId>.<expiryUnix>.<hmac>` — `userId` is hex, so `.` stays a safe separator. */
export async function createSession(env: Env, userId: string): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("no signing key: set SESSION_SECRET (or APP_PASSWORD)");
  const exp = String(Math.floor(Date.now() / 1000) + TTL);
  const payload = `${VERSION}.${userId}.${exp}`;
  return `${payload}.${await hmacHex(key, payload)}`;
}

/** Returns the signed-in `userId`, or `null`. Never throws — a bad cookie is just "no". */
export async function verifySession(env: Env, token: string | undefined): Promise<string | null> {
  const key = signingKey(env);
  if (!token || !key) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, userId, exp, sig] = parts as [string, string, string, string];
  if (version !== VERSION) return null;
  if (!/^[0-9a-f]+$/.test(userId) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const expected = await hmacHex(key, `${version}.${userId}.${exp}`);
  return timingSafeEqual(sig, expected) ? userId : null;
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
