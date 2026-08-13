/// <reference lib="webworker" />
/**
 * The service worker, hand-written (§PUSH, 2026-08-08).
 *
 * It used to be generated (`generateSW`), and generated was the right answer for as long as the SW
 * only had to precache assets. Two things cannot be expressed that way: a `push` handler, and a
 * share target that accepts FILES — a POST share target is delivered to this fetch handler and
 * nowhere else. Both were deferred for exactly this reason; they arrive together because they cost
 * one migration between them.
 *
 * ⚠️ THE RULE THIS FILE MUST NOT BREAK. There is NO navigation fallback, and there must never be
 * one. With `navigateFallback` the SW answers navigations from cache IN THE BROWSER, before the
 * request reaches Cloudflare, and correctness then depends on a hand-maintained denylist of every
 * Worker route. `/auth` and `/demo` were missing from it twice, which silently broke "Sign in with
 * Google" and "Try the demo" — and only in real browsers, because `curl` never sees this layer.
 * Every navigation goes to the network; the Worker decides what a URL means.
 *
 * So this worker does exactly three things: precache the build's static assets, translate a push
 * into a notification, and catch the share-target POST.
 */
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// `autoUpdate` in the plugin config means a new build takes over as soon as it can; without these
// two the user would keep the old worker until every tab closed, and a push handler that does not
// exist yet is indistinguishable from a push that never arrived.
self.addEventListener("install", () => { void self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

// ---- push -------------------------------------------------------------------

const NOTIF_TAG = "money-track";

/**
 * A wake-up arrived. It carries NOTHING — deliberately (see `worker/lib/messaging/webpush.ts`):
 * the text is fetched here, over the user's own session, so no sentence about anybody's money ever
 * passes through Google's or Apple's push infrastructure.
 *
 * The browser requires a notification to be shown for every push it delivers; skip it and it posts
 * its own "this site was updated in the background", which is worse than anything we could say. So
 * the fetch has a fallback, and the fallback is honest rather than invented.
 */
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let title = "Money Track";
    let body = "";
    let url = "/notifications";

    try {
      const res = await fetch("/api/notifications?limit=3", { credentials: "include" });
      if (res.ok) {
        const data = await res.json() as {
          items?: { title: string; body: string | null; read_at: number | null }[];
          unread?: number;
        };
        const unread = (data.items ?? []).filter((n) => !n.read_at);
        if (unread.length === 0) {
          // Already read on another device between the push being sent and this arriving. Saying
          // nothing is not an option (see above), so say the true thing, quietly.
          title = "Money Track";
          body = "";
        } else {
          title = unread[0].title;
          body = unread.length > 1
            ? `${unread[0].body ?? ""}${unread[0].body ? " · " : ""}+${unread.length - 1}`
            : unread[0].body ?? "";
        }
      }
    } catch {
      // Offline, or the session expired. The wake-up itself is still true — something happened —
      // and the app will show what when it is opened.
    }

    await self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // One tag: notifications REPLACE each other instead of stacking. Three nights of unread
      // alerts as three separate banners is how a notification channel gets turned off.
      tag: NOTIF_TAG,
      data: { url },
    });
  })());
});

/**
 * Clicking the notification opens the app — and REUSES an open tab when there is one.
 *
 * Opening a second copy of an app that is already open in the background is the behaviour people
 * read as "this thing does not know what it is doing", and it loses whatever they were doing.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/notifications";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if ("focus" in client) {
        await client.focus();
        // `navigate` can reject on some platforms (a cross-origin or bfcached client); focusing
        // the app is already most of the value, so a failed navigation must not lose the click.
        try { await client.navigate(url); } catch { /* focused, that is enough */ }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

// ---- share target (receipt photo) -------------------------------------------

/**
 * `POST /share-receipt` — a photo shared into the app from the system share sheet.
 *
 * A file share target MUST be a POST, and a POST share target is delivered here rather than to the
 * server: the browser hands the SW a multipart request and expects a redirect back into the app.
 * That is the entire reason this file exists rather than being generated.
 *
 * The file is parked in the Cache API under a fixed key and the page picks it up. Cache rather than
 * IndexedDB because a `Response` is already the shape both sides speak — no schema, no versioning,
 * and a leftover entry is one overwritten key rather than a growing store.
 */
const SHARE_CACHE = "mt-shared";
const SHARE_KEY = "/__shared-receipt";
/**
 * A bank statement shared in from the exporting app.
 *
 * Its own key, not a shared one: the two kinds land on different screens and a single key would
 * mean a photo and a statement racing to overwrite each other in the one case where someone shares
 * both in a row.
 */
const SHARE_STATEMENT_KEY = "/__shared-statement";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share-receipt") return;

  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const cache = await caches.open(SHARE_CACHE);

      const photo = form.get("photo");
      if (photo instanceof File && photo.size > 0) {
        await cache.put(SHARE_KEY, new Response(photo, {
          headers: { "content-type": photo.type || "application/octet-stream" },
        }));
        return Response.redirect("/add?shared=receipt", 303);
      }

      // A statement shared from the banking app. Banks with no API for personal accounts —
      // Raiffeisen, PrivatBank — are a monthly file forever, so the path from "export" to
      // "imported" is worth making one tap instead of download → find in Downloads → open the
      // app → pick the file.
      const statement = form.get("statement");
      if (statement instanceof File && statement.size > 0) {
        await cache.put(SHARE_STATEMENT_KEY, new Response(statement, {
          headers: {
            "content-type": statement.type || "text/csv",
            // The NAME matters here in a way it does not for a photo: it is what the import card
            // shows so the user can tell which of two exports they are looking at.
            "x-mt-filename": encodeURIComponent(statement.name || "statement.csv"),
          },
        }));
        return Response.redirect("/setup?shared=statement", 303);
      }
    } catch {
      /* fall through — a share we cannot read must still land somewhere sensible */
    }
    // 303, not 302: the browser must follow it with GET. A 302 can preserve the POST and the
    // navigation would arrive at the SPA as another POST it has no handler for.
    return Response.redirect("/add", 303);
  })());
});
