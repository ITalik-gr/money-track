// `/push/*` — browser notification subscriptions (§PUSH).
//
// The push itself carries no data; the service worker fetches the notification over the session
// once woken. See `lib/messaging/webpush.ts` for why, and what that removes from this system.
import { apiRoutes } from "./_shared.ts";
import * as pushRepo from "../../repo/push.ts";
import { vapidConfigured } from "../../lib/messaging/webpush.ts";
import type { PushStatus } from "../../../shared/api/push.ts";

export const push = apiRoutes();

/** A push endpoint is a URL from the browser. Anything else is not one. */
const validEndpoint = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > 1000) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
};

/**
 * What the client needs to decide what to render: whether the deployment can push at all, the key
 * to subscribe with, and how many browsers are already subscribed.
 *
 * `configured` is separate from `key` on purpose — a deployment with no VAPID secrets must show
 * "not available here", not a broken permission prompt that fails after the user says yes.
 */
push.get("/push/key", async (c) => c.json({
  configured: vapidConfigured(c.env),
  key: c.env.VAPID_PUBLIC_KEY ?? null,
  subscriptions: await pushRepo.count(c.env.DB),
} satisfies PushStatus));

push.post("/push/subscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string }>().catch(() => ({} as { endpoint?: string }));
  if (!validEndpoint(b.endpoint)) return c.json({ error: "bad_endpoint" }, 400);
  // ⚠️ `p256dh`/`auth` are NOT read, even though the browser sends them: they exist to encrypt a
  // payload we do not send, and storing them would make this table worth stealing.
  await pushRepo.add(c.env.DB, b.endpoint, Math.floor(Date.now() / 1000));
  return c.json({ ok: true });
});

push.post("/push/unsubscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string }>().catch(() => ({} as { endpoint?: string }));
  if (!validEndpoint(b.endpoint)) return c.json({ error: "bad_endpoint" }, 400);
  await pushRepo.remove(c.env.DB, b.endpoint);
  return c.json({ ok: true });
});

/**
 * Send a wake-up to this user's browsers right now.
 *
 * Exists because everything about this feature is invisible until it works: the permission was
 * granted in one browser, the subscription lives in a table, the send happens at 06:00 from a
 * cron. Without a button, the first time anyone learns it is broken is a night it should have
 * fired. Deliberately ignores the "is anything pending" guard — that is what makes it a test.
 */
push.post("/push/test", async (c) => {
  const { sendWakeups, vapidConfigured: ok } = await import("../../lib/messaging/webpush.ts");
  if (!ok(c.env)) return c.json({ error: "push_not_configured" }, 400);
  return c.json(await sendWakeups(c.env));
});
