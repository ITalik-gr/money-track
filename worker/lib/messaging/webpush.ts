/**
 * Web Push — waking a browser, without telling the push service anything.
 *
 * THE DESIGN DECISION THAT SHAPES THIS WHOLE FILE: the push carries NO PAYLOAD. The service worker
 * receives an empty wake-up and then fetches the notification from our own API over the user's
 * session (see `src/sw.ts`). The alternative — the usual one — is to encrypt the text into the push
 * body per RFC 8291 (ECDH + HKDF + AES-GCM against the browser's `p256dh`/`auth` keys).
 *
 * Why not that, for this app specifically:
 *   • Money Track's notifications are sentences about somebody's money («бюджет «Кафе» вичерпано,
 *     3 400 ₴»). Encrypted or not, routing them through Google's and Apple's infrastructure is a
 *     copy of that data leaving the system, and the encryption is only as good as two keys we would
 *     then have to STORE — which turns the subscriptions table into a thing worth stealing.
 *   • Fetching over the session gets the CURRENT state instead of a snapshot from send time, so a
 *     notification already read on the laptop does not ring the phone ten minutes later.
 *   • It removes ~150 lines of hand-rolled crypto from a codebase whose rule is that correctness
 *     must be checkable.
 * The cost is real and stated: the wake-up is useless while offline, and the SW must show
 * SOMETHING even when the fetch fails, or the browser posts its own "site updated in background".
 *
 * VAPID (RFC 8292) is still required — it is what identifies US to the push service, and it is
 * just a signed JWT.
 */
import type { Env } from "../../env.ts";
import * as pushRepo from "../../repo/push.ts";

/** 12 hours. The spec caps it at 24; half of that survives clock skew on either side. */
const JWT_TTL_SEC = 12 * 60 * 60;
/** How long the push service should hold the wake-up for a browser that is offline. */
const PUSH_TTL_SEC = 6 * 60 * 60;

export function vapidConfigured(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * The signing key, rebuilt from the two secrets.
 *
 * The public key is stored the way the browser wants it — an uncompressed P-256 point,
 * `0x04 || X || Y` — and the private key is the raw scalar. A JWK needs them split, so the split
 * happens here rather than storing three secrets that could disagree with each other.
 */
async function signingKey(env: Env): Promise<CryptoKey> {
  const pub = fromB64url(env.VAPID_PUBLIC_KEY!);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 bytes, 0x04 prefix)");
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256",
      x: b64url(pub.slice(1, 33)),
      y: b64url(pub.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY!,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * A VAPID JWT for one push service.
 *
 * `aud` is the push service's ORIGIN, not the endpoint: a token minted for one browser would
 * otherwise be scoped to that browser's URL, and the same token has to serve every subscription on
 * the same service. That also means the token is cacheable per origin, which is why the caller
 * batches by origin below.
 */
async function vapidToken(env: Env, audience: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_SEC,
    // Required by the spec so a push service can contact whoever is sending. `mailto:` of the
    // deployment owner, falling back to the origin — never a made-up address.
    sub: env.OWNER_EMAIL ? `mailto:${env.OWNER_EMAIL}` : audience,
  })));
  const data = new TextEncoder().encode(`${header}.${claims}`);
  // ECDSA here produces the raw `r || s` form the JWS spec wants — not DER. Web Crypto already
  // returns it that way; Node's `crypto.sign` does not, which is the usual source of "invalid JWT"
  // when this is ported.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env), data);
  return `${header}.${claims}.${b64url(sig)}`;
}

export interface PushResult { sent: number; dropped: number; failed: number }

/**
 * Wake every subscribed browser for this user.
 *
 * Returns rather than throws: a push service being down is not a reason for the caller (a cron
 * branch that also writes the feed and pushes Telegram) to stop.
 */
export async function sendWakeups(env: Env): Promise<PushResult> {
  const out: PushResult = { sent: 0, dropped: 0, failed: 0 };
  if (!vapidConfigured(env)) return out;

  const subs = await pushRepo.list(env.DB);
  if (!subs.length) return out;

  const tokens = new Map<string, string>();
  const now = Math.floor(Date.now() / 1000);

  for (const sub of subs) {
    let origin: string;
    try { origin = new URL(sub.endpoint).origin; } catch { await pushRepo.remove(env.DB, sub.endpoint); out.dropped++; continue; }

    try {
      let token = tokens.get(origin);
      if (!token) { token = await vapidToken(env, origin); tokens.set(origin, token); }

      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
          TTL: String(PUSH_TTL_SEC),
          // A notification about money is worth waking a sleeping phone for; `low` would let the
          // browser batch it until the next time the device is used anyway.
          Urgency: "normal",
          // Empty body, explicitly. Some push services reject a POST with neither a body nor a
          // declared length.
          "Content-Length": "0",
        },
      });

      if (res.ok) { await pushRepo.markOk(env.DB, sub.endpoint, now); out.sent++; continue; }

      // 404/410 are the spec's way of saying this subscription no longer exists — the browser was
      // uninstalled, the permission revoked, the profile wiped. Definitive, so delete at once
      // rather than retrying it for five nights.
      if (res.status === 404 || res.status === 410) {
        await pushRepo.remove(env.DB, sub.endpoint);
        out.dropped++;
      } else {
        console.error(`[push] ${origin} responded ${res.status}`);
        await pushRepo.markFail(env.DB, sub.endpoint);
        out.failed++;
      }
    } catch (e) {
      console.error("[push] send failed:", e instanceof Error ? e.message : e);
      await pushRepo.markFail(env.DB, sub.endpoint);
      out.failed++;
    }
  }
  return out;
}

/**
 * Wake browsers if — and only if — something is actually owed.
 *
 * The guard is here rather than at the call site because there are two of them (the cron branch and
 * the manual test button), and "did we already push this" is a property of the notifications, not
 * of who asked.
 */
export async function pushPendingToWeb(env: Env): Promise<{ sent: number; reason?: string }> {
  if (!vapidConfigured(env)) return { sent: 0, reason: "VAPID keys are not configured" };
  const pending = await pushRepo.pendingCount(env.DB);
  if (!pending) return { sent: 0 };
  const r = await sendWakeups(env);
  // Marked once, whatever happened to individual browsers: the alternative is re-pushing the same
  // notification every night to everyone because one dead subscription never succeeds.
  await pushRepo.markPushed(env.DB, Math.floor(Date.now() / 1000));
  return { sent: r.sent };
}
