/**
 * Subscribing this browser to notifications.
 *
 * All of it is capability-gated rather than assumed: a desktop Safari, a Firefox with
 * notifications disabled by policy, an iPhone Safari tab that has NOT been added to the home
 * screen — each of these lacks a different piece, and offering a button that cannot work is worse
 * than not offering one.
 */

/**
 * base64url → the bytes `applicationServerKey` insists on.
 *
 * Returns an `ArrayBuffer` rather than the `Uint8Array` that reads more naturally: the DOM types
 * require a buffer backed by `ArrayBuffer` specifically, and a `Uint8Array` is typed as possibly
 * backed by a `SharedArrayBuffer`. The runtime never cared; the compiler is right that it could.
 */
function decodeKey(base64url: string): ArrayBuffer {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new ArrayBuffer(bin.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return out;
}

export type PushSupport = "ok" | "unsupported" | "needs-install";

/**
 * Whether this browser can subscribe at all.
 *
 * `needs-install` is the iOS case and worth its own answer: Safari has the APIs but refuses the
 * permission until the site is installed to the home screen, and the failure is a rejected promise
 * with no explanation. Telling someone "add it to your home screen first" is a different sentence
 * from "your browser cannot do this".
 */
export function pushSupport(): PushSupport {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    // iOS Safari exposes none of it in a plain tab, but does once installed — so distinguish.
    const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (navigator as { standalone?: boolean }).standalone === true;
    return iOS && !standalone ? "needs-install" : "unsupported";
  }
  return "ok";
}

/** The endpoint this browser is currently subscribed with, or null. */
export async function currentEndpoint(): Promise<string | null> {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

/**
 * Ask for permission and subscribe. Returns the endpoint to register with the server.
 *
 * ⚠️ `userVisibleOnly: true` is not optional — browsers reject a subscription without it, because
 * it is the promise that every push results in something the user can see. Our service worker
 * keeps that promise even when its fetch fails (see `src/sw.ts`).
 */
export async function subscribe(vapidKey: string): Promise<string> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "denied" : "dismissed");

  // `ready`, not `getRegistration`: right after a first load the worker may still be installing,
  // and `pushManager` on a registration without an active worker throws.
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  // Re-subscribing with a DIFFERENT key silently produces a subscription the server cannot push
  // to, so an existing one is reused rather than replaced.
  if (existing) return existing.endpoint;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(vapidKey),
  });
  return sub.endpoint;
}

/** Returns the endpoint that was removed, so the caller can tell the server which one died. */
export async function unsubscribe(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const { endpoint } = sub;
  await sub.unsubscribe();
  return endpoint;
}

// ---- share target -----------------------------------------------------------

const SHARE_CACHE = "mt-shared";
const SHARE_KEY = "/__shared-receipt";

/**
 * Collect a photo shared into the app from the system share sheet.
 *
 * The service worker parked it here and redirected to `/add?shared=receipt`; this takes it and
 * DELETES it, so a reload does not re-upload yesterday's receipt.
 */
export async function takeSharedReceipt(): Promise<File | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(SHARE_KEY);
    if (!res) return null;
    await cache.delete(SHARE_KEY);
    const blob = await res.blob();
    const ext = blob.type.split("/")[1] || "jpg";
    return new File([blob], `shared-receipt.${ext}`, { type: blob.type || "image/jpeg" });
  } catch {
    return null;
  }
}
