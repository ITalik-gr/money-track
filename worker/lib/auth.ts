// Lightweight single-password gate (solo app). Session = "<exp>.<hmac>" signed with
// APP_PASSWORD via Web Crypto; stored in an HttpOnly cookie. No DB, stateless verify.
import type { Env } from "../env.ts";

export const SESSION_COOKIE = "mt_session";
const TTL = 60 * 60 * 24 * 30; // 30 days

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession(env: Env): Promise<string> {
  const exp = String(Math.floor(Date.now() / 1000) + TTL);
  return `${exp}.${await hmacHex(env.APP_PASSWORD, exp)}`;
}

export async function verifySession(env: Env, token: string | undefined): Promise<boolean> {
  if (!token || !env.APP_PASSWORD) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return timingSafeEqual(sig, await hmacHex(env.APP_PASSWORD, exp));
}
